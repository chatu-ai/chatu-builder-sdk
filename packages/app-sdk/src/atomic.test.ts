import { afterAll, beforeEach, describe as d, expect, it } from 'vitest'
import { configure, db, forgetSqlite, kv } from './index'

// 原子写原语（技术方案 34 §2）：setnx / lock / updateIf / getOrCreate
const builtin = (name: string): any => (globalThis as any).process.getBuiltinModule(name)
const { mkdtempSync, rmSync } = builtin('node:fs')
const { tmpdir } = builtin('node:os')
const { join } = builtin('node:path')
const dir: string = mkdtempSync(join(tmpdir(), 'chatu-atomic-'))

afterAll(() => { forgetSqlite(); rmSync(dir, { recursive: true, force: true }) })

/** memory 与 sqlite 两个本地驱动跑同一套用例，保证语义一致 */
const drivers: Array<[string, () => void]> = [
  ['memory', () => configure({ driver: 'memory' })],
  ['sqlite', () => configure({ driver: 'sqlite', sqlitePath: join(dir, 'atomic.sqlite') })],
]

for (const [name, setup] of drivers) {
  d(`${name} driver: 原子写`, () => {
    beforeEach(async () => {
      setup()
      await db.collection('seats').drop()
      await db.collection('users').drop()
      for (const k of (await kv.list('')).keys) await kv.del(k)
    })

    it('setnx：只有第一次写得进去，过期后可以再抢', async () => {
      expect(await kv.setnx('job:1', 'a')).toBe(true)
      expect(await kv.setnx('job:1', 'b')).toBe(false)
      expect(await kv.get('job:1')).toBe('a')
      expect(await kv.del('job:1')).toBe(true)
      expect(await kv.setnx('job:1', 'c')).toBe(true)
      await kv.set('gone', 1, { ex: -1 })
      expect(await kv.setnx('gone', 2)).toBe(true)
    })

    it('lock：同一把锁只有一个持有者，release 之后才能再拿；waitMs=0 时立刻返回 null', async () => {
      const a = await kv.lock('seat:1', { ttlMs: 5000 })
      expect(a).not.toBeNull()
      expect(await kv.lock('seat:1')).toBeNull()
      await a!.release()
      const b = await kv.lock('seat:1')
      expect(b).not.toBeNull()
      await b!.release()
    })

    it('lock：release 只删自己那把（锁超时被别人拿走后不误删）', async () => {
      const a = await kv.lock('x', { ttlMs: 1000 })
      await kv.del('__lock:x')                 // 模拟锁到期
      const b = await kv.lock('x', { ttlMs: 1000 })
      expect(b).not.toBeNull()
      await a!.release()                        // 过期持有者来释放
      expect(await kv.lock('x')).toBeNull()     // b 的锁还在
      await b!.release()
    })

    it('updateIf：条件满足才写，不满足返回 null（名额扣减不会超卖）', async () => {
      const seats = db.collection<{ left: number; status: string }>('seats')
      const seat = await seats.insert({ left: 1, status: 'open' })
      const first = await seats.updateIf(seat._id, { inc: { left: -1 } }, { left: { $gt: 0 }, status: 'open' })
      expect(first?.left).toBe(0)
      const second = await seats.updateIf(seat._id, { inc: { left: -1 } }, { left: { $gt: 0 }, status: 'open' })
      expect(second).toBeNull()
      expect((await seats.get(seat._id))?.left).toBe(0)
      expect(await seats.updateIf('missing', { set: { status: 'x' } }, {})).toBeNull()
    })

    it('updateIf：用 _updatedAt 做乐观锁，版本对不上就不写', async () => {
      const c = db.collection<{ title: string }>('seats')
      const doc = await c.insert({ title: 'v1' })
      await new Promise(r => setTimeout(r, 2))
      await c.update(doc._id, { set: { title: 'v2' } })     // 另一个人先改了
      expect(await c.updateIf(doc._id, { set: { title: 'v3' } }, { _updatedAt: doc._updatedAt })).toBeNull()
      expect((await c.get(doc._id))?.title).toBe('v2')
    })

    it('getOrCreate：同一 filter 只会建一条，已存在时 created=false', async () => {
      const users = db.collection<{ email: string; name: string }>('users')
      const a = await users.getOrCreate({ email: 'a@b.c' }, { email: 'a@b.c', name: '张三' })
      expect(a.created).toBe(true)
      const b = await users.getOrCreate({ email: 'a@b.c' }, { email: 'a@b.c', name: '李四' })
      expect(b.created).toBe(false)
      expect(b.doc._id).toBe(a.doc._id)
      expect(b.doc.name).toBe('张三')
      expect(await users.count()).toBe(1)
      const parallel = await Promise.all([
        users.getOrCreate({ email: 'x@y.z' }, { email: 'x@y.z', name: 'x' }),
        users.getOrCreate({ email: 'x@y.z' }, { email: 'x@y.z', name: 'x' }),
      ])
      expect(parallel.filter(r => r.created)).toHaveLength(1)
      expect(await users.count({ email: 'x@y.z' })).toBe(1)
    })
  })
}

d('platform driver: 原子写走服务端', () => {
  it('setnx 带 nx:true 并读 stored；服务端太旧（没有 stored）时报 SETNX_UNSUPPORTED', async () => {
    const bodies: any[] = []
    let stored = true
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(stored === null ? { ok: true } : { ok: true, stored }), { status: 200 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    expect(await kv.setnx('k', 1, { ex: 30 })).toBe(true)
    expect(bodies[0]).toEqual({ value: 1, ex: 30, nx: true })
    stored = false
    expect(await kv.setnx('k', 1)).toBe(false)
    stored = null as any
    await expect(kv.setnx('k', 1)).rejects.toMatchObject({ code: 'SETNX_UNSUPPORTED' })
  })

  it('updateIf 把 ifMatch 发给 PATCH；409 PRECONDITION_FAILED → null，CONFLICT 照抛', async () => {
    let reply: any = { ok: true, doc: { _id: '1', _createdAt: 1, _updatedAt: 2, left: 0 } }
    const calls: Array<{ url: string; body: any }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      const status = reply.ok === false ? 409 : 200
      return new Response(JSON.stringify(reply), { status })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    const c = db.collection<{ left: number }>('seats')
    expect((await c.updateIf('1', { inc: { left: -1 } }, { left: { $gt: 0 } }))?.left).toBe(0)
    expect(calls[0]!.body).toEqual({ inc: { left: -1 }, upsert: false, ifMatch: { left: { $gt: 0 } } })
    reply = { ok: false, error: 'PRECONDITION_FAILED' }
    expect(await c.updateIf('1', { inc: { left: -1 } }, { left: { $gt: 0 } })).toBeNull()
    reply = { ok: false, error: 'CONFLICT' }
    await expect(c.updateIf('1', { inc: { left: -1 } }, {})).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('getOrCreate 先抢 kv 锁，查到就不插入，最后释放锁', async () => {
    const seen: string[] = []
    let token = ''
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = String(url)
      seen.push(`${init.method} ${u.replace('https://api.test/data/v1', '')}`)
      if (u.includes('/kv/__lock')) {
        if (init.method === 'PUT') { token = JSON.parse(String(init.body)).value; return new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 }) }
        if (init.method === 'GET') return new Response(JSON.stringify({ ok: true, exists: true, value: token }), { status: 200 })
        return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 })
      }
      if (u.includes('/query')) {
        return new Response(JSON.stringify({ ok: true, docs: [{ _id: 'u1', _createdAt: 1, _updatedAt: 1, email: 'a@b.c' }], total: 1, nextSkip: null }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: 'UNEXPECTED' }), { status: 400 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    const r = await db.collection<{ email: string }>('users').getOrCreate({ email: 'a@b.c' }, { email: 'a@b.c' })
    expect(r.created).toBe(false)
    expect(r.doc._id).toBe('u1')
    expect(seen.some(s => s.startsWith('PUT /kv/__lock'))).toBe(true)
    expect(seen.some(s => s.startsWith('DELETE /kv/__lock'))).toBe(true)
    expect(seen.some(s => s.includes('POST /db/users') && !s.includes('/query'))).toBe(false)
  })
})
