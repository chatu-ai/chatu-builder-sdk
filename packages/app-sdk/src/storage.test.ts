import { describe, expect, it } from 'vitest'
import { configure, getStorage, storage } from './index'

describe('storage memory driver', () => {
  it('put/get/head/list/delete', async () => {
    configure({ driver: 'memory' })
    await storage.put('img/a.txt', 'hello', { contentType: 'text/plain' })
    expect(new TextDecoder().decode((await storage.get('img/a.txt'))!)).toBe('hello')
    expect((await storage.head('img/a.txt'))?.size).toBe(5)
    expect((await storage.url('img/a.txt')).startsWith('data:text/plain;base64,')).toBe(true)
    expect((await storage.list('img/')).items.map(i => i.key)).toEqual(['img/a.txt'])
    await storage.delete('img/a.txt')
    expect(await storage.get('img/a.txt')).toBeNull()
  })
})

describe('storage platform driver', () => {
  it('put sends bytes with api key; url signs; list parses', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true, key: 'a/b.png', size: 3 }), { status: 200 })
      if (url.endsWith('/storage/sign')) return new Response(JSON.stringify({ ok: true, url: 'https://cos/signed' }), { status: 200 })
      if (url.includes('/storage?')) return new Response(JSON.stringify({ ok: true, items: [{ key: 'a/b.png', size: 3 }], nextCursor: null }), { status: 200 })
      if (url.endsWith('/storage/upload-url')) return new Response(JSON.stringify({ ok: true, url: 'https://cos/put', expiresIn: 600, headers: { contentType: 'image/png' } }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'PAYMENT_REQUIRED' }), { status: 402 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-x', env: 'dev', fetchImpl })
    const s = getStorage()
    expect(await s.put('a/b.png', new Uint8Array([1, 2, 3]), { contentType: 'image/png' })).toEqual({ key: 'a/b.png', size: 3 })
    expect(calls[0]!.url).toBe('https://api.test/data/v1/storage/a/b.png')
    expect((calls[0]!.init!.headers as any)['x-api-key']).toBe('sk-conv-x')
    expect(await s.url('a/b.png', { expiresIn: 60 })).toBe('https://cos/signed')
    expect((await s.list('a/')).items[0]!.key).toBe('a/b.png')
    expect((await s.uploadUrl('a/c.png', { contentType: 'image/png' })).headers).toEqual({ 'content-type': 'image/png' })
    await expect(s.delete('zzz')).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', status: 402 })
  })
})
