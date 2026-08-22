import { resolveAiConfig, type PlatformConfig } from './config.js'
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

/** ai.json 的选项：schema 用于约束模型输出，validate 用于把结果收成业务类型（可直接传 zod 的 parse） */
export interface AiJsonOptions<T = unknown> extends AiChatOptions {
  /** JSON Schema（会随提示词发给模型，并尽量用 response_format 约束） */
  schema?: Record<string, unknown>
  /** 期望结构的示例，比 schema 更直观，两者可同时给 */
  example?: unknown
  /** 校验/转换；抛错即视为不合格，会带着错误信息重试（zod: v => Schema.parse(v)） */
  validate?: (value: unknown) => T
  /** 结构不合格时的重试次数，默认 1 */
  retries?: number
}

export interface AiClient {
  /** 一次性对话，返回完整回复 */
  chat(messages: AiMessage[] | string, opts?: AiChatOptions): Promise<AiChatResult>
  /**
   * 结构化输出：让模型只回 JSON 并解析成对象；给了 validate 则校验不过会带着错误重试。
   * 用它替代"让模型回一段文本再自己正则抠字段"。
   */
  json<T = unknown>(messages: AiMessage[] | string, opts?: AiJsonOptions<T>): Promise<T>
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

/** 去掉 ```json 代码围栏、取出第一个完整的 JSON 值；模型经常"顺手"包一层 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // 前后可能还有说明文字：截取第一个 { 或 [ 到最后一个 } 或 ]
    const start = trimmed.search(/[[{]/)
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new AppSdkError('AI_INVALID_JSON', `模型返回的不是 JSON：${trimmed.slice(0, 200)}`)
  }
}

/** ai.json 的公共逻辑：约束提示 + response_format + 解析 + 校验 + 带错误重试 */
async function jsonWithRetry<T>(
  chat: (messages: AiMessage[] | string, opts?: AiChatOptions) => Promise<AiChatResult>,
  messages: AiMessage[] | string,
  opts?: AiJsonOptions<T>,
): Promise<T> {
  const base = toMessages(messages)
  const instructions = [
    '只输出 JSON 本身，不要 Markdown 代码块、不要解释文字。',
    opts?.schema ? `必须满足这个 JSON Schema：\n${JSON.stringify(opts.schema)}` : '',
    opts?.example !== undefined ? `结构示例：\n${JSON.stringify(opts.example)}` : '',
  ].filter(Boolean).join('\n')

  const retries = Math.max(0, opts?.retries ?? 1)
  let lastError: unknown
  let repair = ''
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const msgs: AiMessage[] = [
      { role: 'system', content: instructions },
      ...base,
      ...(repair ? [{ role: 'user' as const, content: `上次输出不合格：${repair}\n请只返回修正后的 JSON。` }] : []),
    ]
    const result = await chat(msgs, {
      ...opts,
      // json_object 是 OpenAI 兼容端点的通用写法；不支持的模型会忽略，此时靠提示词与解析兜底
      extra: { response_format: { type: 'json_object' }, ...(opts?.extra ?? {}) },
    })
    try {
      const parsed = extractJson(result.content)
      return opts?.validate ? opts.validate(parsed) : (parsed as T)
    } catch (err) {
      lastError = err
      repair = err instanceof Error ? err.message : String(err)
    }
  }
  throw lastError instanceof AppSdkError
    ? lastError
    : new AppSdkError('AI_INVALID_JSON', `模型输出结构不符合要求（已重试 ${String(retries)} 次）：${String(lastError)}`)
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
    async json(messages, opts) {
      return jsonWithRetry(
        (msgs, o) => this.chat(msgs, o),
        messages,
        opts,
      )
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
    json: async () => fail(),
    stream: () => ({ [Symbol.asyncIterator]: async function* () { fail() } }),
    models: async () => fail(),
  }
}

let cached: { key: string; fetchImpl?: typeof fetch; client: AiClient } | null = null

/** 按当前配置取 AI 客户端（惰性、缓存；configure() 后自动重建） */
export function getAi(): AiClient {
  const cfg = resolveAiConfig()
  const key = cfg ? `platform|${cfg.aiBaseUrl}|${cfg.aiModel ?? ''}|${cfg.apiKey.slice(-4)}` : 'none'
  const fetchImpl = cfg?.fetchImpl
  if (!cached || cached.key !== key || cached.fetchImpl !== fetchImpl) cached = { key, fetchImpl, client: cfg ? platformAi(cfg) : notConfigured() }
  return cached.client
}

/** 便捷单例：`import { ai } from '@chatu-ai/app-sdk'` */
export const ai: AiClient = {
  chat: (m, o) => getAi().chat(m, o),
  json: (m, o) => getAi().json(m, o),
  stream: (m, o) => getAi().stream(m, o),
  models: () => getAi().models(),
}
