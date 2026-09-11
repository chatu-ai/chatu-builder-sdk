import { describe as d, expect, it } from 'vitest'
import { configure, storage } from './index'

// 缩略图（技术方案 37）
d('storage.thumbnail', () => {
  it('平台驱动：POST /storage/thumb，参数原样传，返回 url', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ ok: true, key: '_thumb/320x320cover.webp/a.jpg', url: 'https://cdn.test/thumb.webp?sig=1', generated: true }), { status: 200 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })

    const src = await storage.thumbnail('a.jpg', { width: 320, height: 320, fit: 'cover', format: 'webp', expiresIn: 600 })
    expect(src).toBe('https://cdn.test/thumb.webp?sig=1')
    expect(calls[0]!.url).toBe('https://api.test/data/v1/storage/thumb')
    expect(calls[0]!.body).toEqual({ key: 'a.jpg', width: 320, height: 320, fit: 'cover', format: 'webp', expiresIn: 600, refresh: undefined })
  })

  it('平台驱动：服务端报错原样抛出（尺寸非法 / 不是图片）', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'IMAGE_DECODE_FAILED', message: '这个对象不是能识别的图片' }), { status: 400 })) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    await expect(storage.thumbnail('a.txt', { width: 100 })).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED', status: 400 })
  })

  it('memory 驱动：不缩放，退回原图地址（页面不炸）', async () => {
    configure({ driver: 'memory' })
    await storage.put('a.png', new Uint8Array([1, 2, 3]), { contentType: 'image/png' })
    const src = await storage.thumbnail('a.png', { width: 100 })
    expect(src).toBe(await storage.url('a.png'))
    expect(src.startsWith('data:image/png;base64,')).toBe(true)
  })
})
