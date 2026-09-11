import { afterAll, beforeEach, describe as d, expect, it } from 'vitest'
import { auth, configure, db, describe, forgetSqlite, kv, storage } from './index'

// 包里没有 @types/node（SDK 不绑定运行时），内置模块与驱动一样走 process.getBuiltinModule
const builtin = (name: string): any => (globalThis as any).process.getBuiltinModule(name)
const { mkdtempSync, existsSync, rmSync } = builtin('node:fs')
const { tmpdir } = builtin('node:os')
const { join } = builtin('node:path')

// sqlite 驱动（技术方案 33）：db / kv 落同一个文件；用临时目录跑一遍与 memory 驱动同口径的用例
const dir: string = mkdtempSync(join(tmpdir(), 'chatu-sqlite-'))
const file: string = join(dir, 'nested', 'chatu.sqlite') // 父目录不存在，验证自动创建

afterAll(() => {
  forgetSqlite()
  rmSync(dir, { recursive: true, force: true })
})

interface Todo { title: string; done: boolean; tags?: string[]; priority?: number; owner?: { name: string } }

async function seed() {
  const c = db.collection<Todo>('todos')
  await c.insert({ title: '买牛奶', done: false, priority: 2, tags: ['家务'], owner: { name: 'a' } })
  await new Promise(r => setTimeout(r, 2))
  await c.insert({ title: '写周报', done: true, priority: 1, tags: ['工作'], owner: { name: 'b' } })
  await new Promise(r => setTimeout(r, 2))
  await c.insert({ title: '订机票', done: false, priority: 3, tags: ['工作', '出差'] })
  return c
}

d('sqlite driver: db', () => {
  beforeEach(async () => {
    configure({ driver: 'sqlite', sqlitePath: file })
    await db.collection('todos').drop()
  })

  it('describe 报 sqlite；文件与父目录自动创建', async () => {
    expect(describe()).toMatchObject({ driver: 'sqlite', db: `sqlite:${file}`, kv: `sqlite:${file}`, storage: 'memory', auth: 'unsupported' })
    await db.collection('todos').insert({ title: 'x', done: false })
    expect(existsSync(file)).toBe(true)
  })

  it('insert 补 _id/_createdAt/_updatedAt，get/find 可读回；元字段不重复存进 body', async () => {
    const c = await seed()
    const { docs, total, nextSkip } = await c.find({ sort: { _createdAt: 1 } })
    expect(total).toBe(3)
    expect(nextSkip).toBeNull()
    expect(docs.map(t => t.title)).toEqual(['买牛奶', '写周报', '订机票'])
    expect(docs[0]!._id).toMatch(/^[0-9a-z]+$/)
    expect(docs[0]!._createdAt).toBeLessThanOrEqual(docs[1]!._createdAt)
    expect(await c.get(docs[0]!._id)).toMatchObject({ title: '买牛奶', owner: { name: 'a' }, tags: ['家务'] })
    expect(await c.get('nope')).toBeNull()
  })

  it('filter / sort / 分页与 memory 驱动同语义', async () => {
    const c = await seed()
    expect((await c.find({ filter: { done: false } })).total).toBe(2)
    expect((await c.find({ filter: { priority: { $gte: 2 } } })).total).toBe(2)
    expect((await c.find({ filter: { title: { $contains: '牛奶' } } })).total).toBe(1)
    expect((await c.find({ filter: { tags: { $contains: '工作' } } })).total).toBe(2)
    expect((await c.find({ filter: { 'owner.name': 'b' } })).docs[0]!.title).toBe('写周报')
    expect((await c.find({ filter: { $or: [{ priority: 1 }, { priority: 3 }] } })).total).toBe(2)
    const page = await c.find({ sort: { priority: -1 }, limit: 2 })
    expect(page.docs.map(t => t.priority)).toEqual([3, 2])
    expect(page.nextSkip).toBe(2)
    expect(await c.count({ done: false })).toBe(2)
    expect(await c.count()).toBe(3)
    expect((await c.findOne({ done: true }))?.title).toBe('写周报')
  })

  it('update（set/inc/unset/upsert）/ replace / delete / deleteMany / collections', async () => {
    const c = await seed()
    const id = (await c.findOne({ title: '买牛奶' }))!._id
    const u = await c.update(id, { set: { done: true }, inc: { priority: 5 }, unset: ['tags'] })
    expect(u).toMatchObject({ done: true, priority: 7 })
    expect(u!.tags).toBeUndefined()
    expect(u!._updatedAt).toBeGreaterThanOrEqual(u!._createdAt)
    expect(await c.get(id)).toMatchObject({ done: true, priority: 7 })
    expect(await c.update('missing', { set: { title: 'a' } })).toBeNull()
    const up = await c.update('fixed-id', { set: { title: 'upserted', done: false }, upsert: true })
    expect(up?._id).toBe('fixed-id')
    const r = await c.replace(id, { title: '只剩标题', done: false })
    expect(r).toMatchObject({ _id: id, title: '只剩标题' })
    expect(r.tags).toBeUndefined()
    expect(await c.delete(id)).toBe(true)
    expect(await c.delete(id)).toBe(false)
    expect(await c.deleteMany({ done: false })).toBe(2) // 订机票 + upserted
    expect(await c.count()).toBe(1)
    await db.collection('other').insert({ a: 1 })
    expect(await db.collections()).toEqual([{ name: 'other', count: 1 }, { name: 'todos', count: 1 }])
    await db.collection('other').drop()
    expect(await db.collections()).toEqual([{ name: 'todos', count: 1 }])
  })

  it('数据落盘：遗忘连接后重新打开仍可读', async () => {
    const c = await seed()
    forgetSqlite(file)
    expect(await c.count()).toBe(3)
  })
})

d('sqlite driver: kv', () => {
  beforeEach(async () => {
    configure({ driver: 'sqlite', sqlitePath: file })
    for (const k of (await kv.list('')).keys) await kv.del(k)
  })

  it('set/get/del/mget、JSON 值原样读回', async () => {
    await kv.set('a', { n: 1, s: '中' })
    await kv.set('b', 2)
    expect(await kv.get('a')).toEqual({ n: 1, s: '中' })
    expect(await kv.mget(['a', 'b', 'c'])).toEqual([{ n: 1, s: '中' }, 2, null])
    expect(await kv.del('a')).toBe(true)
    expect(await kv.del('a')).toBe(false)
    expect(await kv.get('a')).toBeNull()
  })

  it('incr 与 expire；过期后读不到', async () => {
    expect(await kv.incr('cnt')).toBe(1)
    expect(await kv.incr('cnt', 5)).toBe(6)
    await kv.set('str', 'x')
    await expect(kv.incr('str')).rejects.toMatchObject({ code: 'NOT_AN_INTEGER' })
    await kv.set('t', 1, { ex: 1 })
    expect(await kv.expire('nope', 1)).toBe(false)
    expect(await kv.expire('t', 1)).toBe(true)
    await kv.set('gone', 1, { ex: -1 }) // 负数立即过期
    expect(await kv.get('gone')).toBeNull()
  })

  it('list 按前缀 + 游标分页，_ % 不当通配符', async () => {
    await kv.set('user:1', 1)
    await kv.set('user:2', 1)
    await kv.set('user_x', 1)
    await kv.set('other', 1)
    expect((await kv.list('user:')).keys).toEqual(['user:1', 'user:2'])
    expect((await kv.list('user_')).keys).toEqual(['user_x'])
    const p1 = await kv.list('', { limit: 3 })
    expect(p1.keys).toHaveLength(3)
    expect(p1.nextCursor).toBe('3')
    const p2 = await kv.list('', { limit: 3, cursor: p1.nextCursor! })
    expect(p2.keys).toHaveLength(1)
    expect(p2.nextCursor).toBeNull()
  })
})

d('sqlite + 平台配置：auth / storage 仍走平台', () => {
  it('describe 的 storage/auth 为 platform，auth 请求打到平台', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'a@b.c' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    configure({ driver: 'sqlite', sqlitePath: file, baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    expect(describe()).toMatchObject({ driver: 'sqlite', storage: 'platform', auth: 'platform', env: 'prod' })
    await auth.getSession('tok-1')
    expect(calls.some(c => c.includes('https://api.test/data/v1/auth/'))).toBe(true)
    expect(typeof storage.put).toBe('function')
    // db 仍是本地：不该有 /db/ 请求
    await db.collection('todos').count()
    expect(calls.some(c => c.includes('/db/'))).toBe(false)
  })

  it('没有平台配置时 auth 报 AUTH_UNSUPPORTED', async () => {
    configure({ driver: 'sqlite', sqlitePath: file })
    await expect(auth.getSession('tok-1')).rejects.toMatchObject({ code: 'AUTH_UNSUPPORTED' })
  })
})
