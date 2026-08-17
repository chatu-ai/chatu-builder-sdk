import { beforeEach, describe as d, expect, it } from 'vitest'
import { configure, describe, getKv, kv } from './index'

d('memory driver', () => {
  beforeEach(() => configure({ driver: 'memory' }))
  it('round-trips, ttl, incr, list', async () => {
    expect(describe().driver).toBe('memory')
    await kv.set('todos:1', { a: 1 })
    expect(await kv.get('todos:1')).toEqual({ a: 1 })
    expect(await kv.incr('views')).toBe(1)
    expect(await kv.incr('views', 5)).toBe(6)
    await kv.set('todos:2', 'x', { ex: 1 })
    expect((await kv.list('todos:')).keys).toEqual(['todos:1', 'todos:2'])
    expect(await kv.mget(['todos:1', 'nope'])).toEqual([{ a: 1 }, null])
    expect(await kv.del('todos:1')).toBe(true)
  })
})

d('platform driver', () => {
  it('sends x-api-key / x-chatu-env and unwraps responses', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (init.method === 'GET' && url.endsWith('/kv/todos%3A1')) return new Response(JSON.stringify({ ok: true, exists: true, value: { a: 1 } }), { status: 200 })
      if (init.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.endsWith('/kv/incr')) return new Response(JSON.stringify({ ok: true, value: 7 }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'INVALID_KEY' }), { status: 400 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    expect(describe()).toEqual({ driver: 'platform', env: 'prod', baseUrl: 'https://api.test/data/v1' })
    await getKv().set('todos:1', { a: 1 }, { ex: 60 })
    expect(await kv.get('todos:1')).toEqual({ a: 1 })
    expect(await kv.incr('views', 7)).toBe(7)
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['x-api-key']).toBe('sk-conv-abc')
    expect(h['x-chatu-env']).toBe('prod')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ value: { a: 1 }, ex: 60 })
    await expect(kv.get('bad*')).rejects.toMatchObject({ code: 'INVALID_KEY', status: 400 })
  })
})

d('byo driver', () => {
  it('resolves from REDIS_URL / S3_BUCKET and reports missing optional deps clearly', async () => {
    const proc = (globalThis as any).process
    proc.env.REDIS_URL = 'redis://127.0.0.1:1'
    proc.env.S3_BUCKET = 'b'
    configure({})
    expect(describe()).toEqual({ driver: 'byo', kv: 'redis', storage: 's3' })
    await expect(kv.get('x')).rejects.toThrow(/ioredis|ECONNREFUSED|connect/i)
    delete proc.env.REDIS_URL
    delete proc.env.S3_BUCKET
    configure({ driver: 'memory' })
  })
})
