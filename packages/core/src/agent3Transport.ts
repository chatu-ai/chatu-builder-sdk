/**
 * Agent3 SSE 直通传输 —— A2ATransport 的 REST/SSE 实现（P0 步骤一，对接 BuilderController）。
 * 产出的是**已翻译**的 BuilderEvent（而非 A2A 原始事件），因此配套 client 需用 identity 解析。
 */
import type { AuthProvider } from './auth'
import { Agent3Translator } from './agent3'
import { createBuilderClient, type A2ATransport } from './client'
import type { BuilderEvent } from './events'
import type { ResilienceOptions } from './resume'
import { readSse } from './sse'

export interface Agent3TransportOptions {
  /** BuilderController 前缀，如 https://api.example.com/web/Builder */
  baseUrl: string
  auth: AuthProvider
  fetchImpl?: typeof fetch
}

export interface Agent3Transport {
  stream(conversationId: string, prompt: string, opts?: { agentId?: string; attachments?: unknown[] }): AsyncIterable<BuilderEvent>
  resubscribe(conversationId: string, xid: string, lastSeq: number): AsyncIterable<BuilderEvent>
  cancel(conversationId: string, xid: string): Promise<void>
}

export function createAgent3Transport(options: Agent3TransportOptions): Agent3Transport {
  const { baseUrl, auth } = options

  async function* translated(src: AsyncIterable<unknown>, translator: Agent3Translator): AsyncIterable<BuilderEvent> {
    for await (const raw of src) {
      for (const ev of translator.translate(raw)) yield ev
    }
  }

  return {
    stream(conversationId, prompt, opts) {
      const translator = new Agent3Translator()
      const init = auth.apply({
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ conversationId, prompt, agentId: opts?.agentId }),
      })
      return translated(readSse(`${baseUrl}/create`, init, { fetchImpl: options.fetchImpl }), translator)
    },
    resubscribe(conversationId, xid, lastSeq) {
      const translator = new Agent3Translator()
      const init = auth.apply({ method: 'GET', headers: { accept: 'text/event-stream' } })
      const url = `${baseUrl}/connect?conversationId=${conversationId}&xid=${xid}&checkpoint=${lastSeq}`
      return translated(readSse(url, init, { fetchImpl: options.fetchImpl }), translator)
    },
    async cancel(conversationId, xid) {
      const init = auth.apply({ method: 'POST' })
      await (options.fetchImpl ?? fetch)(`${baseUrl}/cancel?conversationId=${conversationId}&xid=${xid}`, init)
    },
  }
}

/**
 * 便捷工厂：agent3 SSE 直通形态的完整 BuilderClient（P0 步骤一，chat-web USE_MOCK=false 即用此）。
 * conversationId 通过闭包绑定到 transport（A2ATransport.resubscribe 只带 xid）。
 */
export function createAgent3Client(
  conversationId: string,
  options: Agent3TransportOptions & { restBase?: string; agentId?: string; resilience?: ResilienceOptions },
) {
  const transport = createAgent3Transport(options)
  const a2aLike: A2ATransport = {
    stream: (cid, prompt, opts) => transport.stream(cid, prompt, { ...opts, agentId: opts?.agentId ?? options.agentId }),
    resubscribe: (xid, lastSeq) => transport.resubscribe(conversationId, xid, lastSeq),
    cancel: xid => transport.cancel(conversationId, xid),
  }
  return createBuilderClient({
    restBase: options.restBase ?? options.baseUrl,
    transport: a2aLike,
    auth: options.auth,
    fetchImpl: options.fetchImpl,
    resilience: options.resilience,
    parse: e => e as BuilderEvent, // transport 已产出 BuilderEvent
  })
}
