/**
 * SSE 传输（BuilderController create/connect）：fetch 流式读取 → 逐条 data 行 → JSON。
 * 与 EventSource 相比支持 POST + 自定义 header + AbortSignal。
 */
export interface SseOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** 逐条产出 SSE data 载荷（已 JSON.parse；非 JSON 行原样以 string 产出；[DONE] 结束） */
export async function* readSse(
  url: string,
  init: RequestInit,
  opts: SseOptions = {},
): AsyncIterable<unknown> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(url, { ...init, signal: opts.signal ?? init.signal })
  if (!res.ok || !res.body) {
    throw new Error(`sse ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 300))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          yield data
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
