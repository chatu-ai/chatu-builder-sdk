import { resolveConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'

/**
 * 应用内 AI 能力（LLM 中继）：走平台的 OpenAI 兼容端点 `POST {aiBaseUrl}/chat/completions`，
 * 用与 Data API 相同的应用密钥（sk-conv-…）鉴权，用量由平台按 api-key 计入应用所有者的 ChatU 点数。
 * 只在服务端使用（Route Handler / Server Action）；密钥不得暴露给浏览器。
 */
export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface AiChatOptions {
  /** 模型 id；缺省用 CHATU_AI_MODEL / PRIMARY_MODEL，都没有则不传由服务端决定 */
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 透传到请求体的其它 OpenAI 兼容字段（如 top_p、stop、response_format） */
  extra?: Record<string, unknown>
}

export interface AiUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface AiChatResult { content: string; model?: string; usage?: AiUsage }

export interface AiClient {
  /** 一次性对话，返回完整回复 */
  chat(messages: AiMessage[] | string, opts?: AiChatOptions): Promise<AiChatResult>
  /** 流式对话，逐段产出文本增量 */
  stream(messages: AiMessage[] | string, opts?: AiChatOptions): AsyncIterable<string>
  /** 可用模型 id 列表 */
  models(): Promise<string[]>
}

const toMessages = (input: AiMessage[] | string): AiMessage[] => (typeof input === 'string' ? [{ role: 'user', content: input }] : input)

function buildBody(cfg: PlatformConfig, messages: AiMessage[] | string, opts: AiChatOptions | undefined, stream: boolean): Record<string, unknown> {
  const model = opts?.model ?? cfg.aiModel
  const body: Record<string, unknown> = { ...(opts?.extra ?? {}), messages: toMessages(messages) }
  if (model) body.model = model
  if (opts?.temperature !== undefined) body.temperature = opts.temperature
  if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (stream) body.stream = true
  return body
}

async function throwHttpError(res: Response, what: string): Promise<never> {
  let json: any = null
  let text = ''
  try { text = await res.text(); json = JSON.parse(text) } catch { /* not json */ }
  const err = json?.error
  const code = (typeof err === 'object' && err?.code) || (typeof err === 'string' && err) || json?.code || `HTTP_${res.status}`
  const message = (typeof err === 'object' && err?.message) || json?.message || (text ? text.slice(0, 300) : `${what} failed (${res.status})`)
  throw new AppSdkError(String(code), String(message), res.status)
}

/** 解析 OpenAI 风格 SSE：`data: {...}` 行，`[DONE]` 结束；产出 choices[0].delta.content */
export async function* parseSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (line: string): string | null | undefined => {
    const t = line.trim()
    if (!t.startsWith('data:')) return undefined
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') return payload === '[DONE]' ? null : undefined
    try {
      const json = JSON.parse(payload)
      const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text
      return typeof delta === 'string' && delta.length ? delta : undefined
    } catch { return undefined }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const r = handle(line)
        if (r === null) return
        if (r !== undefined) yield r
      }
    }
    if (buf.trim()) { const r = handle(buf); if (r) yield r }
  } finally {
    reader.releaseLock()
  }
}

// ---------- platform driver ----------
function platformAi(cfg: PlatformConfig): AiClient {
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
  return {
    async chat(messages, opts) {
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(buildBody(cfg, messages, opts, false)), signal: opts?.signal,
      })
      if (!res.ok) await throwHttpError(res, 'ai.chat')
      const json: any = await res.json()
      const msg = json?.choices?.[0]?.message
      const content = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : ''
      const u = json?.usage
      return {
        content,
        model: typeof json?.model === 'string' ? json.model : undefined,
        usage: u ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens } : undefined,
      }
    },
    stream(messages, opts) {
      const start = async (): Promise<ReadableStream<Uint8Array>> => {
        const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/chat/completions`, {
          method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(buildBody(cfg, messages, opts, true)), signal: opts?.signal,
        })
        if (!res.ok) await throwHttpError(res, 'ai.stream')
        if (!res.body) throw new AppSdkError('EMPTY_BODY', 'ai.stream: response has no body')
        return res.body
      }
      return { [Symbol.asyncIterator]: async function* () { yield* parseSseDeltas(await start()) } }
    },
    async models() {
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/models`, { method: 'GET', headers: { authorization: headers.authorization } })
      if (!res.ok) await throwHttpError(res, 'ai.models')
      const json: any = await res.json()
      const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
      return list.map(m => (typeof m === 'string' ? m : m?.id)).filter((id): id is string => typeof id === 'string')
    },
  }
}

const NOT_CONFIGURED = 'AI is only available with the platform driver: set CHATU_DATA_URL/CHATU_APP_KEY (or CHATU_AI_URL) — copied from the Builder publish panel; there is no memory/byo fallback for LLM calls'

function notConfigured(): AiClient {
  const fail = () => { throw new AppSdkError('AI_NOT_CONFIGURED', NOT_CONFIGURED) }
  return {
    chat: async () => fail(),
    stream: () => ({ [Symbol.asyncIterator]: async function* () { fail() } }),
    models: async () => fail(),
  }
}

let cached: { key: string; fetchImpl?: typeof fetch; client: AiClient } | null = null

/** 按当前配置取 AI 客户端（惰性、缓存；configure() 后自动重建） */
export function getAi(): AiClient {
  const cfg = resolveConfig()
  const key = cfg.kind === 'platform' ? `platform|${cfg.aiBaseUrl}|${cfg.aiModel ?? ''}|${cfg.apiKey.slice(-4)}` : cfg.kind
  const fetchImpl = cfg.kind === 'platform' ? cfg.fetchImpl : undefined
  if (!cached || cached.key !== key || cached.fetchImpl !== fetchImpl) cached = { key, fetchImpl, client: cfg.kind === 'platform' ? platformAi(cfg) : notConfigured() }
  return cached.client
}

/** 便捷单例：`import { ai } from '@chatu-ai/app-sdk'` */
export const ai: AiClient = {
  chat: (m, o) => getAi().chat(m, o),
  stream: (m, o) => getAi().stream(m, o),
  models: () => getAi().models(),
}
