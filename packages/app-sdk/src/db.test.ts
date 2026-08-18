import { beforeEach, describe as d, expect, it } from 'vitest'
import { configure, db, describe, matchesFilter, registerOptionalModule } from './index'

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

d('memory driver: db', () => {
  beforeEach(async () => {
    configure({ driver: 'memory' })
    await db.collection('todos').drop() // 内存驱动跨用例保留数据，每个用例从干净集合开始
  })

  it('insert 补 _id/_createdAt/_updatedAt，get/find 可读回', async () => {
    expect(describe().driver).toBe('memory')
    const c = await seed()
    const { docs, total, nextSkip } = await c.find({ sort: { _createdAt: 1 } })
    expect(total).toBe(3)
    expect(nextSkip).toBeNull()
    expect(docs.map(t => t.title)).toEqual(['买牛奶', '写周报', '订机票'])
    expect(docs[0]!._id).toMatch(/^[0-9a-z]+$/)
    expect(docs[0]!._createdAt).toBeLessThanOrEqual(docs[1]!._createdAt)
    expect(await c.get(docs[0]!._id)).toMatchObject({ title: '买牛奶' })
    expect(await c.get('nope')).toBeNull()
  })

  it('filter：等值 / 操作符 / 嵌套路径 / $or', async () => {
    const c = await seed()
    expect((await c.find({ filter: { done: false } })).total).toBe(2)
    expect((await c.find({ filter: { priority: { $gte: 2 } } })).total).toBe(2)
    expect((await c.find({ filter: { title: { $contains: '牛奶' } } })).total).toBe(1)
    expect((await c.find({ filter: { tags: { $contains: '工作' } } })).total).toBe(2)
    expect((await c.find({ filter: { 'owner.name': 'b' } })).total).toBe(1)
    expect((await c.find({ filter: { owner: { $exists: false } } })).total).toBe(1)
    expect((await c.find({ filter: { priority: { $in: [1, 3] } } })).total).toBe(2)
    expect((await c.find({ filter: { $or: [{ done: true }, { priority: 3 }] } })).total).toBe(2)
    expect(await c.count({ done: true })).toBe(1)
    expect((await c.findOne({ done: true }))?.title).toBe('写周报')
  })

  it('sort + 分页：nextSkip 串起下一页', async () => {
    const c = await seed()
    const p1 = await c.find({ sort: { priority: -1 }, limit: 2 })
    expect(p1.docs.map(t => t.priority)).toEqual([3, 2])
    expect(p1.nextSkip).toBe(2)
    const p2 = await c.find({ sort: { priority: -1 }, skip: p1.nextSkip!, limit: 2 })
    expect(p2.docs.map(t => t.priority)).toEqual([1])
    expect(p2.nextSkip).toBeNull()
  })

  it('update：set / unset / inc / upsert，replace 保留 _createdAt', async () => {
    const c = await seed()
    const first = (await c.find({ sort: { _createdAt: 1 }, limit: 1 })).docs[0]!
    const updated = await c.update(first._id, { set: { done: true }, inc: { priority: 10 }, unset: ['tags'] })
    expect(updated).toMatchObject({ done: true, priority: 12 })
    expect(updated!.tags).toBeUndefined()
    expect(updated!._createdAt).toBe(first._createdAt)
    expect(updated!._updatedAt).toBeGreaterThanOrEqual(first._updatedAt)
    expect(await c.update('missing', { set: { done: true } })).toBeNull()
    const upserted = await c.update('fixed-id', { set: { title: '新建', done: false }, upsert: true })
    expect(upserted).toMatchObject({ _id: 'fixed-id', title: '新建' })
    const replaced = await c.replace(first._id, { title: '换掉了', done: false })
    expect(replaced.title).toBe('换掉了')
    expect(replaced._createdAt).toBe(first._createdAt)
  })

  it('delete / deleteMany / drop / collections', async () => {
    const c = await seed()
    const one = (await c.find({ limit: 1 })).docs[0]!
    expect(await c.delete(one._id)).toBe(true)
    expect(await c.delete(one._id)).toBe(false)
    expect(await c.deleteMany({ done: true })).toBe(1)
    expect((await db.collections()).find(x => x.name === 'todos')?.count).toBe(1)
    await c.drop()
    expect((await c.find()).total).toBe(0)
  })
})

d('platform driver: db', () => {
  it('调用 Data API 并透传 filter/sort/分页', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/db/todos/query')) {
        return new Response(JSON.stringify({ ok: true, docs: [{ _id: 'a', _createdAt: 1, _updatedAt: 1, title: 'x' }], total: 3, nextSkip: 1 }), { status: 200 })
      }
      if (url.endsWith('/db/todos/count?filter=%7B%22done%22%3Afalse%7D')) return new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 })
      if (url.endsWith('/db/todos/a')) return new Response(JSON.stringify({ ok: true, exists: true, doc: { _id: 'a', _createdAt: 1, _updatedAt: 1, title: 'x' } }), { status: 200 })
      if (url.endsWith('/db/todos') && init.method === 'POST') return new Response(JSON.stringify({ ok: true, ids: ['a'] }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'UNEXPECTED', url }), { status: 400 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })

    const c = db.collection<Todo>('todos')
    const saved = await c.insert({ title: 'x', done: false })
    expect(saved._id).toBe('a')
    const r = await c.find({ filter: { done: false }, sort: { _createdAt: -1 }, limit: 1 })
    expect(r.total).toBe(3)
    expect(r.nextSkip).toBe(1)
    expect(await c.count({ done: false })).toBe(2)

    const query = calls.find(x => x.url.endsWith('/query'))!
    expect(JSON.parse(String(query.init.body))).toEqual({ filter: { done: false }, sort: { _createdAt: -1 }, limit: 1 })
    expect((query.init.headers as Record<string, string>)['x-api-key']).toBe('sk-conv-abc')
    expect((query.init.headers as Record<string, string>)['x-chatu-env']).toBe('prod')
  })
})

d('edgeone driver: db', () => {
  it('文档落在 Blob 的 db/{coll}/{id}，查询在内存过滤', async () => {
    const stores = new Map<string, Map<string, unknown>>()
    const getStore = (arg: string | { name: string }) => {
      const name = typeof arg === 'string' ? arg : arg.name
      let m = stores.get(name)
      if (!m) { m = new Map(); stores.set(name, m) }
      const map = m
      return {
        async setJSON(key: string, value: unknown) { map.set(key, value) },
        async set(key: string, value: unknown) { map.set(key, value) },
        async get(key: string) { return map.get(key) ?? null },
        async delete(key: string) { map.delete(key) },
        async list(opts?: { prefix?: string }) {
          return { blobs: [...map.keys()].filter(k => k.startsWith(opts?.prefix ?? '')).sort().map(key => ({ key, etag: 'x' })) }
        },
      }
    }
    registerOptionalModule('@edgeone/pages-blob', { getStore })
    configure({ driver: 'edgeone' })

    const c = db.collection<Todo>('todos')
    await c.insert({ title: '买牛奶', done: false, priority: 2 })
    await c.insert({ title: '写周报', done: true, priority: 1 })
    expect([...stores.get('chatu-kv')!.keys()].every(k => k.startsWith('db/todos/'))).toBe(true)
    expect((await c.find({ filter: { done: false } })).total).toBe(1)
    expect((await c.find({ sort: { priority: -1 } })).docs[0]!.title).toBe('买牛奶')
    expect((await db.collections()).find(x => x.name === 'todos')?.count).toBe(2)
    const target = (await c.find({ filter: { done: true } })).docs[0]!
    expect((await c.update(target._id, { inc: { priority: 5 } }))!.priority).toBe(6)
    expect(await c.delete(target._id)).toBe(true)
    expect((await c.find()).total).toBe(1)
  })
})

d('matchesFilter 边界', () => {
  it('未知操作符不匹配；$ne 对缺失字段成立；$nin 排除', () => {
    expect(matchesFilter({ a: 1 }, { a: { $unknown: 1 } })).toBe(false)
    expect(matchesFilter({ a: 1 }, { b: { $ne: 2 } })).toBe(true)
    expect(matchesFilter({ a: 1 }, { a: { $nin: [1, 2] } })).toBe(false)
    expect(matchesFilter({ a: 1 }, {})).toBe(true)
  })
})
