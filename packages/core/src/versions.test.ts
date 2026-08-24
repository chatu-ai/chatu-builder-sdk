import { describe, expect, it } from 'vitest'
import { createBuilderClient, CookieAuth } from './index'

function clientWith(handler: (url: string) => unknown) {
  const urls: string[] = []
  const client = createBuilderClient({
    restBase: 'https://api.test/web/Builder',
    auth: new CookieAuth(),
    transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
    fetchImpl: (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(handler(String(url))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch,
  })
  return { client, urls }
}

describe('versions.diff / versions.patch（E2 版本对比）', () => {
  it('diff 返回改动文件清单', async () => {
    const { client, urls } = clientWith(() => ({
      sha: 'abc1234',
      message: '加上待办列表',
      files: [{ path: 'src/app/page.tsx', status: 'M', additions: 12, deletions: 3, binary: false }],
      truncated: false,
    }))

    const diff = await client.versions.diff('conv-1', 'abc1234')

    expect(urls[0]).toContain('/conv-1/versions/abc1234/diff')
    expect(diff.message).toBe('加上待办列表')
    expect(diff.files[0]).toMatchObject({ path: 'src/app/page.tsx', status: 'M', additions: 12 })
  })

  it('沙箱休眠时服务端回空体，diff 也要是合法结构而不是 undefined', async () => {
    const { client } = clientWith(() => ({ files: [] }))

    const diff = await client.versions.diff('conv-1', 'abc1234')

    expect(diff).toEqual({ sha: 'abc1234', message: '', files: [], truncated: false })
  })

  it('patch 把文件路径放进查询串并回填 path', async () => {
    const { client, urls } = clientWith(() => ({ patch: '@@ -1 +1 @@\n-a\n+b\n', truncated: true }))

    const patch = await client.versions.patch('conv-1', 'abc1234', 'src/app/page.tsx')

    expect(urls[0]).toContain('path=src%2Fapp%2Fpage.tsx')
    expect(patch.path).toBe('src/app/page.tsx')
    expect(patch.truncated).toBe(true)
    expect(patch.patch).toContain('+b')
  })
})
