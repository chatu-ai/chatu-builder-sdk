import { describe, expect, it } from 'vitest'
import { createBuilderClient, CookieAuth } from './index'

/** 把若干行组成一个 SSE 响应体 */
const sse = (body: string) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const frame = (id: string, data: unknown, event?: string) =>
  `${event ? `event:${event}\n` : ''}id:${id}\ndata:${JSON.stringify(data)}\n\n`

function clientWith(handler: (url: string) => Response) {
  const urls: string[] = []
  const client = createBuilderClient({
    restBase: 'https://api.test/web/Builder',
    auth: new CookieAuth(),
    transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
    fetchImpl: (async (url: string) => {
      urls.push(String(url))
      return handler(String(url))
    }) as unknown as typeof fetch,
  })
  return { client, urls }
}

describe('runs.events（v2 事件订阅，技术方案 22 Phase 2）', () => {
  it('逐帧产出 id/event/data，遇到 done 结束', async () => {
    const { client } = clientWith(() =>
      sse(frame('1-0', { type: 'run.phase', phase: 'sandbox' }) +
          frame('2-0', { type: 'created-response', xid: 'x1' }) +
          frame('3-0', { type: 'run.finished' }, 'done')))

    const got = []
    for await (const f of client.runs.events('run-1')) got.push(f)

    expect(got.map(f => f.id)).toEqual(['1-0', '2-0', '3-0'])
    expect(got[2]!.event).toBe('done')
    expect((got[1]!.data as { xid: string }).xid).toBe('x1')
  })

  it('中途断流会带着最后一帧的 id 续订（不重复投递已收到的帧）', async () => {
    let call = 0
    const { client, urls } = clientWith(() => {
      call += 1
      // 第一次：只吐两帧就结束（模拟 Web 重启/网关超时），没有 done
      if (call === 1) return sse(frame('1-0', { i: 1 }) + frame('2-0', { i: 2 }))
      return sse(frame('3-0', { i: 3 }) + frame('4-0', { type: 'run.finished' }, 'done'))
    })

    const got = []
    for await (const f of client.runs.events('run-1', { maxRetries: 2, retryBaseMs: 1 })) got.push(f)

    expect(got.map(f => (f.data as { i?: number }).i ?? 'done')).toEqual([1, 2, 3, 'done'])
    expect(urls[0]).not.toContain('after=')
    expect(urls[1]).toContain('after=2-0')
  })

  it('可以从指定 id 开始订阅（页面刷新后接着看）', async () => {
    const { client, urls } = clientWith(() => sse(frame('9-0', { i: 9 }, 'done')))
    for await (const _ of client.runs.events('run-1', { after: '8-0' })) { /* drain */ }
    expect(urls[0]).toContain('after=8-0')
  })

  it('心跳注释行被忽略', async () => {
    const { client } = clientWith(() => sse(': ping\n\n' + frame('1-0', { i: 1 }, 'done')))
    const got = []
    for await (const f of client.runs.events('run-1')) got.push(f)
    expect(got).toHaveLength(1)
  })

  it('一直有新帧就一直续订（长任务不该被重试次数掐断）', async () => {
    let call = 0
    const { client } = clientWith(() => {
      call += 1
      // 每次连上都给一帧新数据然后断开；第 4 次给 done
      return call >= 4
        ? sse(frame(`${call}-0`, { type: 'run.finished' }, 'done'))
        : sse(frame(`${call}-0`, { i: call }))
    })
    const got = []
    for await (const f of client.runs.events('run-1', { maxRetries: 1, retryBaseMs: 1 })) got.push(f)
    expect(got).toHaveLength(4)
  })

  it('连上就断且没有任何数据时，重试用尽即结束（不死循环）', async () => {
    const { client, urls } = clientWith(() => sse(''))
    const got = []
    for await (const f of client.runs.events('run-1', { maxRetries: 2, retryBaseMs: 1 })) got.push(f)
    expect(got).toHaveLength(0)
    expect(urls.length).toBe(3) // 首次 + 2 次重试
  })
})
