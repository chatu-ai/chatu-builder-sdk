import { beforeEach, describe as d, expect, it } from 'vitest'
import { configure, describe, kv, storage, registerOptionalModule, encodeKvKey, decodeKvKey } from './index'

/** 内存版 Pages Blob store：模拟 @edgeone/pages-blob 的 getStore */
function fakeBlobModule() {
  const stores = new Map<string, Map<string, { body: Blob | string; json?: unknown }>>()
  const getStore = (arg: string | { name: string }) => {
    const name = typeof arg === 'string' ? arg : arg.name
    let m = stores.get(name)
    if (!m) { m = new Map(); stores.set(name, m) }
    const map = m
    return {
      async set(key: string, value: any) { map.set(key, { body: value }) },
      async setJSON(key: string, value: unknown) { map.set(key, { body: JSON.stringify(value), json: value }) },
      async get(key: string, opts?: { type?: string }) {
        const e = map.get(key)
        if (!e) return null
        if (opts?.type === 'json') return e.json ?? JSON.parse(String(e.body))
        if (opts?.type === 'arrayBuffer') return e.body instanceof Blob ? await e.body.arrayBuffer() : new TextEncoder().encode(String(e.body)).buffer
        return e.body instanceof Blob ? await e.body.text() : String(e.body)
      },
      async getMetadata(key: string) { const e = map.get(key); return e ? { headers: { 'content-length': String(e.body instanceof Blob ? e.body.size : String(e.body).length) } } : null },
      async delete(key: string) { map.delete(key) },
      async list(opts?: { prefix?: string; limit?: number }) {
        const keys = [...map.keys()].filter(k => k.startsWith(opts?.prefix ?? '')).sort()
        return { blobs: keys.slice(0, opts?.limit ?? 100).map(key => ({ key, etag: 'x' })) }
      },
      async createUploadUrl(key: string, opts?: { expireSeconds?: number }) { return { url: `https://blob.test/${name}/${key}?sig=1`, key, expiresAt: Date.now() + (opts?.expireSeconds ?? 3600) * 1000 } },
    }
  }
  return { getStore, stores }
}

d('edgeone driver (Pages Blob)', () => {
  beforeEach(() => {
    registerOptionalModule('@edgeone/pages-blob', fakeBlobModule())
    configure({ driver: 'edgeone' })
  })
  it('kv: envelope, ttl, incr, list with encoded prefix', async () => {
    expect(describe().driver).toBe('edgeone')
    await kv.set('todos:1', { a: 1 })
    expect(await kv.get('todos:1')).toEqual({ a: 1 })
    expect(await kv.incr('views')).toBe(1)
    expect(await kv.incr('views', 5)).toBe(6)
    await kv.set('todos:2', 'x', { ex: -1 }) // 已过期
    expect(await kv.get('todos:2')).toBeNull()
    await kv.set('todos:3', 'y')
    expect((await kv.list('todos:')).keys).toEqual(['todos:1', 'todos:3'])
    expect(await kv.mget(['todos:1', 'nope'])).toEqual([{ a: 1 }, null])
    expect(await kv.del('todos:1')).toBe(true)
    expect(await kv.del('todos:1')).toBe(false)
  })
  it('storage: put/get/head/list/uploadUrl/url', async () => {
    const r = await storage.put('photos/a.txt', 'hello', { contentType: 'text/plain' })
    expect(r.size).toBe(5)
    expect(new TextDecoder().decode((await storage.get('photos/a.txt'))!)).toBe('hello')
    expect((await storage.head('photos/a.txt'))?.size).toBe(5)
    expect((await storage.list('photos/')).items.map(i => i.key)).toEqual(['photos/a.txt'])
    const up = await storage.uploadUrl('photos/b.png', { contentType: 'image/png' })
    expect(up.method).toBe('PUT')
    expect(up.url).toContain('photos/b.png')
    expect(await storage.url('photos/a.txt', { downloadName: 'x.txt' })).toBe('/_chatu/blob/photos/a.txt?download=x.txt')
    await storage.delete('photos/a.txt')
    expect(await storage.get('photos/a.txt')).toBeNull()
  })
  it('key encoding keeps prefix order and round-trips', () => {
    expect(encodeKvKey('todos:1/x y')).toBe('todos%3A1/x%20y')
    expect(decodeKvKey(encodeKvKey('a:b/c d'))).toBe('a:b/c d')
    expect(encodeKvKey('todos:12').startsWith(encodeKvKey('todos:1'))).toBe(true)
  })
})
