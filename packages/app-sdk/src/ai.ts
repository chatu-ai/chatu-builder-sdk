import { resolveAiConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'
import { isStandardSchema, validateWith, type StandardSchemaV1 } from './schema.js'

/**
 * 应用内 AI 能力（LLM 中继）：走平台的 OpenAI 兼容端点 `POST {aiBaseUrl}/chat/completions`，
 * 用与 Data API 相同的应用密钥（sk-conv-…）鉴权，用量由平台按 api-key 计入应用所有者的 ChatU 点数。
 * 只在服务端使用（Route Handler / Server Action）；密钥不得暴露给浏览器。
 *
 * 同一套密钥还能用：`/embeddings`（向量）、`document-intelligence/analyze`（OCR / 文档解析）、
 * `/agents/{agent}/tasks`（平台智能体：当前开放图片生成，ai.generateImage）。
 */

/** 多模态消息片段：文本或图片（图片用 https URL 或 `data:image/...;base64,...`，见 toDataUrl） */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 字符串，或多模态片段数组（图片理解） */
  content: string | AiContentPart[]
  name?: string
  /** role=tool 时必填：对应 assistant 消息里 toolCalls[].id */
  toolCallId?: string
  /** role=assistant 时可带：模型上一轮发起的工具调用（runTools 会自动回填） */
  toolCalls?: AiToolCall[]
}

/** 工具定义（OpenAI function calling）；parameters 为 JSON Schema */
export interface AiTool<TArgs = any, TResult = unknown> {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  /** 给了 execute，ai.runTools 会自动执行并把结果回填给模型；返回值会 JSON 序列化 */
  execute?: (args: TArgs) => Promise<TResult> | TResult
}

/** 模型发起的一次工具调用；arguments 已解析（解析失败时为 null，rawArguments 保留原文） */
export interface AiToolCall { id: string; name: string; arguments: any; rawArguments: string }

export interface AiChatOptions {
  /** 模型 id；缺省用 CHATU_AI_MODEL / PRIMARY_MODEL，都没有则不传由服务端决定 */
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 可供模型调用的工具；chat() 只返回 toolCalls 不执行，要自动执行用 runTools() */
  tools?: AiTool[]
  /** 'auto'（默认）| 'none' | 'required' | 指定某个工具名 */
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  /** 透传到请求体的其它 OpenAI 兼容字段（如 top_p、stop、response_format） */
  extra?: Record<string, unknown>
}

/** ai.stream 的选项：流式不支持工具调用（SSE 增量里的 tool_calls 不解析），要用工具走 ai.runTools / ai.chat */
export type AiStreamOptions = Omit<AiChatOptions, 'tools' | 'toolChoice'>

export interface AiUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface AiChatResult {
  content: string
  model?: string
  usage?: AiUsage
  /** 模型要求调用的工具（给了 tools 时才可能有）；有它时 content 通常为空 */
  toolCalls?: AiToolCall[]
  /** 'stop' | 'tool_calls' | 'length' | … */
  finishReason?: string
}

/** ai.json 的选项：schema 用于约束模型输出，validate 用于把结果收成业务类型（可直接传 zod schema 或 parse 函数） */
export interface AiJsonOptions<T = unknown> extends AiChatOptions {
  /**
   * JSON Schema：随提示词发给模型，并用 `response_format: json_schema` 硬约束（服务端/模型不支持时自动降级为 json_object）。
   * 也可以直接传 Standard Schema（zod / valibot）——此时它同时充当 validate；zod 4 会自动转出 JSON Schema。
   */
  schema?: Record<string, unknown> | StandardSchemaV1<unknown, T>
  /** 期望结构的示例，比 schema 更直观，两者可同时给 */
  example?: unknown
  /** 校验/转换；抛错即视为不合格，会带着错误信息重试（zod: v => Schema.parse(v)，或直接传 zod schema） */
  validate?: ((value: unknown) => T) | StandardSchemaV1<unknown, T>
  /** 结构不合格时的重试次数，默认 1 */
  retries?: number
  /** 是否要求严格模式（json_schema strict=true，要求 schema 每个对象都 additionalProperties:false）；默认 false */
  strict?: boolean
}

export interface AiRunToolsOptions extends AiChatOptions {
  /** 带 execute 的工具列表（必填） */
  tools: AiTool[]
  /** 最多来回几轮工具调用，默认 5；超过则抛 AI_TOOL_ROUNDS_EXCEEDED */
  maxRounds?: number
  /** 每次工具执行后的回调（调试/进度展示） */
  onToolCall?: (call: AiToolCall, result: unknown) => void
}
export interface AiRunToolsResult extends AiChatResult {
  /** 完整的消息序列（含每轮 assistant/tool 消息），可原样存下来续聊 */
  messages: AiMessage[]
  /** 实际发生的工具调用及其结果 */
  steps: Array<{ call: AiToolCall; result: unknown }>
}

/** 流式结果：可 `for await` 逐段取文本；迭代结束后 usage / content 可读 */
export interface AiStream extends AsyncIterable<string> {
  /** 迭代完成后可用（服务端总是带 usage 块） */
  readonly usage: AiUsage | undefined
  /** 迭代完成后可用：拼好的完整文本 */
  readonly content: string
  /** 迭代完成后可用 */
  readonly finishReason: string | undefined
}

export interface AiEmbedOptions {
  /** embedding 模型；缺省 CHATU_AI_EMBED_MODEL → text-embedding-3-small */
  model?: string
  /** 输出维度（text-embedding-3-* 支持缩短，如 256/512）；缺省用模型默认（3-small 为 1536） */
  dimensions?: number
  signal?: AbortSignal
}
export interface AiEmbedManyResult { vectors: number[][]; model?: string; usage?: AiUsage }

/** OCR 附加能力，每项按页额外计费；默认全不开 */
export type AiOcrFeature = 'highResolution' | 'formulas' | 'fontStyling' | 'barcodes' | 'languages' | 'keyValuePairs' | 'queryFields' | 'figures' | 'searchablePdf'
export interface AiOcrOptions {
  /** 文件名（带扩展名，服务端据此判断类型）：pdf / png / jpg / tiff / docx / xlsx / pptx / html */
  filename: string
  /** OCR 模型标识；留空用默认版面分析模型 */
  model?: string
  features?: AiOcrFeature[]
  /** features 含 queryFields 时要提取的字段名，如 ['发票号码', '金额'] */
  queryFields?: string[]
  signal?: AbortSignal
}
export interface AiOcrPage { pageNumber: number; width?: number; height?: number; unit?: string; angle?: number; lines: string[] }
export interface AiOcrResult {
  /** 整篇文档的 Markdown 文本（表格已转 Markdown 表格）——喂给 LLM 直接用这个 */
  content: string
  pages: AiOcrPage[]
  /** 服务端原始 AnalyzeResult（表格/键值对/查询字段等细节都在这里） */
  raw: any
}

/**
 * 生图 agent。按张计费（点数因 agent 而异，Seedream4 最便宜、NanoBanana 系列约 2 倍），
 * 平台白名单外的 agent 会 404。
 */
export type AiImageAgent = 'Seedream4' | 'Seedream5Lite' | 'Seedream45' | 'Seedream5Pro' | 'NanoBanana' | 'NanoBananaPro' | 'Image2' | (string & {})
export interface AiImageOptions {
  /** 生图提示词（中英文均可） */
  prompt: string
  /** 缺省 CHATU_AI_IMAGE_AGENT → Seedream4 */
  agent?: AiImageAgent
  /** 生成张数，默认 1；上限因 agent 而异（Seedream ≤15、NanoBanana ≤8、Image2 ≤4），每张都计费 */
  count?: number
  /**
   * 尺寸/比例：'1K' | '2K' | '4K'（分辨率档）、'16:9'（比例）或 '1024x1024'（像素）。
   * 各 agent 支持的写法不同，SDK 按 agent 家族映射到对应参数：Seedream 三种都收；NanoBanana 收档位（Pro）与比例；Image2 只收 1024x1024 / 1536x1024 / 1024x1536。
   */
  size?: string
  /** 参考图 https URL（图生图 / 风格参考）；Image2 不支持 */
  referenceImages?: string[]
  /** 透传给 agent 的其它参数（如 Seedream 的 watermark / seed，Image2 的 quality），会覆盖 SDK 的映射 */
  extra?: Record<string, unknown>
  signal?: AbortSignal
}
export interface AiGeneratedImage {
  /** 图片 URL（平台存储，可直接展示或下载） */
  url: string
  thumbnailUrl?: string
  index: number
  /** 实际尺寸（如 '2048x2048'），部分 agent 才有 */
  size?: string
  /** 模型随图返回的文字（NanoBanana 系列可能有） */
  text?: string
}
export interface AiImageResult {
  images: AiGeneratedImage[]
  agent: string
  /** 平台任务 id */
  taskId?: string
  /** 实际使用的模型版本 */
  model?: string
  /** agent 原样返回的 metadata / usage（各 agent 字段不一致，计费点数等看这里） */
  metadata?: any
  usage?: any
}
/** 应用可调用的平台智能体（ai.agents） */
export interface AiAgentInfo { id: string; name?: string; description?: string; version?: string; iconUrl?: string; type?: string }

export interface AiClient {
  /** 一次性对话，返回完整回复；content 可含图片片段（图片理解）；带 tools 时可能返回 toolCalls */
  chat(messages: AiMessage[] | string, opts?: AiChatOptions): Promise<AiChatResult>
  /**
   * 结构化输出：让模型只回 JSON 并解析成对象；给了 validate / Standard Schema 则校验不过会带着错误重试。
   * 用它替代"让模型回一段文本再自己正则抠字段"。
   */
  json<T = unknown>(messages: AiMessage[] | string, opts?: AiJsonOptions<T>): Promise<T>
  /** 流式对话，逐段产出文本增量；迭代结束后可读 usage / content。不支持 tools（传了会抛错） */
  stream(messages: AiMessage[] | string, opts?: AiStreamOptions): AiStream
  /**
   * 工具调用循环：模型要调工具 → 执行 tools[].execute → 结果回填 → 直到模型给出最终回复。
   * 适合"查订单 / 查天气 / 算价格再回答"的智能体场景。
   */
  runTools(messages: AiMessage[] | string, opts: AiRunToolsOptions): Promise<AiRunToolsResult>
  /** 文本向量（单条），配合 vectorSearch 做语义检索 / 知识库 */
  embed(text: string, opts?: AiEmbedOptions): Promise<number[]>
  /** 文本向量（批量，一次请求；建议每批 ≤ 100 条） */
  embedMany(texts: string[], opts?: AiEmbedOptions): Promise<AiEmbedManyResult>
  /** OCR / 文档解析：PDF、图片、Office 文档 → Markdown 文本 + 分页信息；按页计费 */
  ocr(file: Uint8Array | ArrayBuffer | Blob, opts: AiOcrOptions): Promise<AiOcrResult>
  /** 可用模型 id 列表 */
  models(): Promise<string[]>
  /**
   * 文生图 / 图生图：调用平台生图 agent，同步等待（通常 5~60 秒，多图高质量可到 2~3 分钟），返回图片 URL 列表。
   * 按张计费到应用所有者；失败（含余额不足）抛 AppSdkError。
   */
  generateImage(opts: AiImageOptions): Promise<AiImageResult>
  /** 应用可调用的平台智能体列表（当前只开放图片类） */
  agents(): Promise<AiAgentInfo[]>
}

const toMessages = (input: AiMessage[] | string): AiMessage[] => (typeof input === 'string' ? [{ role: 'user', content: input }] : input)

/** 把二进制转成 `data:` URL，用于图片理解（ai.chat 的 image_url）；bytes 可来自 File/Blob.arrayBuffer() */
export function toDataUrl(bytes: Uint8Array | ArrayBuffer, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`
}

function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const B = (globalThis as { Buffer?: { from(a: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (B) return B.from(u8).toString('base64')
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** SDK 消息 → OpenAI 线格式（toolCallId / toolCalls 改成 snake_case） */
function toWireMessage(m: AiMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.name) out.name = m.name
  if (m.role === 'tool' && m.toolCallId) out.tool_call_id = m.toolCallId
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }))
    if (out.content === '') out.content = null
  }
  return out
}

function toWireTools(tools: AiTool[]): unknown[] {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } }))
}

function buildBody(cfg: PlatformConfig, messages: AiMessage[] | string, opts: AiChatOptions | undefined, stream: boolean): Record<string, unknown> {
  const model = opts?.model ?? cfg.aiModel
  const body: Record<string, unknown> = { ...(opts?.extra ?? {}), messages: toMessages(messages).map(toWireMessage) }
  if (model) body.model = model
  if (opts?.temperature !== undefined) body.temperature = opts.temperature
  if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (opts?.tools?.length) {
    body.tools = toWireTools(opts.tools)
    const tc = opts.toolChoice
    if (tc) body.tool_choice = typeof tc === 'string' ? tc : { type: 'function', function: { name: tc.name } }
  }
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

function parseUsage(u: any): AiUsage | undefined {
  return u && typeof u === 'object' ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens } : undefined
}

function parseToolCalls(raw: unknown): AiToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw.map((c: any, i: number) => {
    const rawArguments = typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {})
    let parsed: any = null
    try { parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {} } catch { parsed = null }
    return { id: String(c?.id ?? `call_${i}`), name: String(c?.function?.name ?? ''), arguments: parsed, rawArguments }
  })
}

/** SSE 事件（OpenAI 风格）：文本增量、usage 块、finish_reason */
type SseEvent = { delta?: string; usage?: AiUsage; finishReason?: string }

/** 解析 OpenAI 风格 SSE：`data: {...}` 行，`[DONE]` 结束 */
async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (line: string): SseEvent | null | undefined => {
    const t = line.trim()
    if (!t.startsWith('data:')) return undefined
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') return payload === '[DONE]' ? null : undefined
    try {
      const json = JSON.parse(payload)
      const choice = json?.choices?.[0]
      const delta = choice?.delta?.content ?? choice?.text
      const ev: SseEvent = {}
      if (typeof delta === 'string' && delta.length) ev.delta = delta
      const usage = parseUsage(json?.usage)
      if (usage) ev.usage = usage
      if (typeof choice?.finish_reason === 'string') ev.finishReason = choice.finish_reason
      return ev.delta !== undefined || ev.usage || ev.finishReason ? ev : undefined
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

/** 解析 OpenAI 风格 SSE，只产出 choices[0].delta.content（保留给外部/测试用） */
export async function* parseSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const ev of parseSseEvents(body)) if (ev.delta !== undefined) yield ev.delta
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

/**
 * 从 Standard Schema 尽量拿到 JSON Schema：只认实例上的 toJSONSchema()（部分库有）。
 * zod 4 的转换器是 `z.toJSONSchema(schema)` 而不在实例上——要硬约束请显式传 `schema: z.toJSONSchema(S), validate: S`；
 * 拿不到时仍能工作，只是靠提示词 + json_object + 校验重试。
 */
function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  const s = schema as { toJSONSchema?: () => Record<string, unknown> }
  try { return typeof s.toJSONSchema === 'function' ? s.toJSONSchema() : undefined } catch { return undefined }
}

/**
 * 判断"这个中继/模型不认识 json_schema"，只有这种情况才值得降级重发。
 * 做法是宽进 + 扣掉误判：拒绝的措辞各家不一（"Supported values are: 'text' and 'json_object'"、
 * "response_format.type only support …"、pydantic 的 "Input should be 'text' or 'json_object'"），
 * 列举"不支持"的说法必然漏；但**schema 自己写错**（strict 模式最常见）绝不能当成中继不支持——
 * 那样 strict 静默失效、真正的错误被吞掉，还白白多计一次费。所以只把这一类明确排除掉。
 */
function isResponseFormatRejected(err: unknown): boolean {
  if (!(err instanceof AppSdkError)) return false
  if (err.status !== 400 && err.status !== 422) return false
  const msg = err.message
  // schema 本身不合法：原样抛给调用方去改 schema
  if (/invalid schema|additional propert|not permitted|additionalproperties/i.test(msg)) return false
  return /response_format|json_schema|json_object/i.test(msg)
}

/** ai.json 的公共逻辑：约束提示 + response_format（json_schema → json_object 降级）+ 解析 + 校验 + 带错误重试 */
async function jsonWithRetry<T>(
  chat: (messages: AiMessage[] | string, opts?: AiChatOptions) => Promise<AiChatResult>,
  messages: AiMessage[] | string,
  opts?: AiJsonOptions<T>,
): Promise<T> {
  const base = toMessages(messages)
  const std = isStandardSchema(opts?.schema) ? (opts!.schema as StandardSchemaV1<unknown, T>) : isStandardSchema(opts?.validate) ? (opts!.validate as StandardSchemaV1<unknown, T>) : undefined
  const jsonSchema: Record<string, unknown> | undefined = opts?.schema && !isStandardSchema(opts.schema) ? (opts.schema as Record<string, unknown>) : std ? jsonSchemaOf(std) : undefined
  const validateFn = typeof opts?.validate === 'function' ? opts.validate : undefined
  const validate = async (v: unknown): Promise<T> => (validateFn ? validateFn(v) : std ? validateWith(std, v, 'AI_INVALID_JSON', '模型输出') : (v as T))

  const instructions = [
    '只输出 JSON 本身，不要 Markdown 代码块、不要解释文字。',
    jsonSchema ? `必须满足这个 JSON Schema：\n${JSON.stringify(jsonSchema)}` : '',
    opts?.example !== undefined ? `结构示例：\n${JSON.stringify(opts.example)}` : '',
  ].filter(Boolean).join('\n')

  // 有 JSON Schema 时优先用 json_schema 硬约束；被拒绝（老模型/不支持的中继）后本次调用内降级为 json_object
  let responseFormat: Record<string, unknown> = jsonSchema
    ? { type: 'json_schema', json_schema: { name: 'result', schema: jsonSchema, strict: opts?.strict === true } }
    : { type: 'json_object' }

  const retries = Math.max(0, opts?.retries ?? 1)
  let lastError: unknown
  let repair = ''
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const msgs: AiMessage[] = [
      { role: 'system', content: instructions },
      ...base,
      ...(repair ? [{ role: 'user' as const, content: `上次输出不合格：${repair}\n请只返回修正后的 JSON。` }] : []),
    ]
    const callOpts = (): AiChatOptions => ({ ...opts, tools: undefined, extra: { response_format: responseFormat, ...(opts?.extra ?? {}) } })
    let result: AiChatResult
    try {
      result = await chat(msgs, callOpts())
    } catch (err) {
      if (responseFormat.type !== 'json_schema' || !isResponseFormatRejected(err)) throw err
      responseFormat = { type: 'json_object' }
      result = await chat(msgs, callOpts())
    }
    try {
      const parsed = extractJson(result.content)
      return await validate(parsed)
    } catch (err) {
      lastError = err
      repair = err instanceof Error ? err.message : String(err)
    }
  }
  throw lastError instanceof AppSdkError
    ? lastError
    : new AppSdkError('AI_INVALID_JSON', `模型输出结构不符合要求（已重试 ${String(retries)} 次）：${String(lastError)}`)
}

/** ai.runTools 的公共逻辑：chat → 执行 toolCalls → 追加 tool 消息 → 再 chat */
async function runToolsLoop(
  chat: (messages: AiMessage[], opts?: AiChatOptions) => Promise<AiChatResult>,
  messages: AiMessage[] | string,
  opts: AiRunToolsOptions,
): Promise<AiRunToolsResult> {
  const history: AiMessage[] = [...toMessages(messages)]
  const steps: AiRunToolsResult['steps'] = []
  const maxRounds = Math.max(1, opts.maxRounds ?? 5)
  const byName = new Map(opts.tools.map(t => [t.name, t]))
  const usage: AiUsage = {}
  const addUsage = (u?: AiUsage) => {
    if (!u) return
    usage.promptTokens = (usage.promptTokens ?? 0) + (u.promptTokens ?? 0)
    usage.completionTokens = (usage.completionTokens ?? 0) + (u.completionTokens ?? 0)
    usage.totalTokens = (usage.totalTokens ?? 0) + (u.totalTokens ?? 0)
  }
  for (let round = 0; round <= maxRounds; round += 1) {
    // 最后一轮不再给工具，逼模型直接作答，避免无限调用
    const last = round === maxRounds
    const result = await chat(history, { ...opts, tools: last ? undefined : opts.tools, toolChoice: last ? undefined : opts.toolChoice })
    addUsage(result.usage)
    if (!result.toolCalls?.length) {
      history.push({ role: 'assistant', content: result.content })
      return { ...result, usage, messages: history, steps }
    }
    // 最后一轮已经不给 tools 了还要调工具：直接放弃，不能先执行（execute 的副作用会跑，调用方却只拿到异常）
    if (last) throw new AppSdkError('AI_TOOL_ROUNDS_EXCEEDED', `工具调用超过 ${String(maxRounds)} 轮仍未结束`)
    history.push({ role: 'assistant', content: result.content ?? '', toolCalls: result.toolCalls })
    for (const call of result.toolCalls) {
      const tool = byName.get(call.name)
      let output: unknown
      if (!tool?.execute) {
        output = { error: `unknown tool: ${call.name}` }
      } else if (call.arguments === null) {
        output = { error: `invalid JSON arguments: ${call.rawArguments.slice(0, 200)}` }
      } else {
        try { output = await tool.execute(call.arguments) } catch (err) { output = { error: err instanceof Error ? err.message : String(err) } }
      }
      steps.push({ call, result: output })
      opts.onToolCall?.(call, output)
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: typeof output === 'string' ? output : JSON.stringify(output ?? null) })
    }
  }
  throw new AppSdkError('AI_TOOL_ROUNDS_EXCEEDED', `工具调用超过 ${String(maxRounds)} 轮仍未结束`)
}

const OCR_FLAGS: Record<AiOcrFeature, number> = { highResolution: 1, formulas: 2, fontStyling: 4, barcodes: 8, languages: 16, keyValuePairs: 32, queryFields: 64, figures: 128, searchablePdf: 256 }

function parseOcrResult(raw: any): AiOcrResult {
  const pages: AiOcrPage[] = Array.isArray(raw?.pages)
    ? raw.pages.map((p: any, i: number) => ({
        pageNumber: Number(p?.pageNumber ?? i + 1),
        width: p?.width, height: p?.height, unit: p?.unit, angle: p?.angle,
        lines: Array.isArray(p?.lines) ? p.lines.map((l: any) => String(l?.content ?? '')).filter(Boolean) : [],
      }))
    : []
  const content = typeof raw?.content === 'string' ? raw.content : pages.map(p => p.lines.join('\n')).join('\n\n')
  return { content, pages, raw }
}

/** 生图缺省 agent：白名单里最便宜的一档 */
export const DEFAULT_IMAGE_AGENT = 'Seedream4'

/** 'WxH' → 约分后的 'W:H'（NanoBanana 只收比例） */
function toAspectRatio(size: string): string | undefined {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
  if (!m) return /^\d+:\d+$/.test(size) ? size : undefined
  let a = Number(m[1]), b = Number(m[2])
  if (!a || !b) return undefined
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x)
  const g = gcd(a, b)
  a /= g; b /= g
  return `${String(a)}:${String(b)}`
}

/**
 * SDK 统一选项 → 各 agent 家族的入参。字段名以服务端 agent 的输入模型为准（camelCase，服务端大小写不敏感）：
 * - Seedream*：prompt / size / maxImages / referenceImageUrls
 * - NanoBanana*：prompt / count / aspectRatio / imageSize(Pro) / referenceImageUrls
 * - Image2：prompt / count / size
 * 未知 agent 按 Seedream 口径组装；opts.extra 最后合并、可覆盖任何字段。
 */
export function buildImageInput(agent: string, opts: AiImageOptions): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: opts.prompt }
  const count = opts.count ?? 1
  const size = opts.size?.trim()
  const refs = opts.referenceImages?.filter(Boolean)
  const family = /^nanobanana/i.test(agent) ? 'nanobanana' : /^image2$/i.test(agent) ? 'image2' : 'seedream'
  if (family === 'nanobanana') {
    input.count = count
    if (size) {
      if (/^\d+K$/i.test(size)) input.imageSize = size.toUpperCase()
      else { const r = toAspectRatio(size); if (r) input.aspectRatio = r }
    }
    if (refs?.length) input.referenceImageUrls = refs
  } else if (family === 'image2') {
    input.count = count
    if (size) input.size = size
  } else {
    input.maxImages = count
    if (size) input.size = size
    if (refs?.length) input.referenceImageUrls = refs
  }
  return { ...input, ...(opts.extra ?? {}) }
}

/** /v1/agents 任务响应 → AiImageResult；非完成态或无图抛错 */
export function parseImageTask(agent: string, task: any): AiImageResult {
  const state = typeof task?.state === 'string' ? task.state : 'unknown'
  const out = task?.output
  if (state !== 'completed') {
    const msg = typeof task?.error === 'string' && task.error ? task.error : `ai.generateImage: agent 任务未完成（state=${state}）`
    const code = /insufficient balance|余额不足/i.test(msg) ? 'AI_INSUFFICIENT_BALANCE' : 'AI_IMAGE_FAILED'
    throw new AppSdkError(code, msg, code === 'AI_INSUFFICIENT_BALANCE' ? 402 : undefined)
  }
  const list: any[] = Array.isArray(out?.images) ? out.images : []
  const images: AiGeneratedImage[] = list
    .map((im, i) => {
      const url = typeof im?.imageUrl === 'string' ? im.imageUrl : typeof im?.url === 'string' ? im.url : ''
      const img: AiGeneratedImage = { url, index: typeof im?.index === 'number' ? im.index : i }
      if (typeof im?.thumbnailUrl === 'string' && im.thumbnailUrl) img.thumbnailUrl = im.thumbnailUrl
      if (typeof im?.size === 'string' && im.size) img.size = im.size
      if (typeof im?.generatedText === 'string' && im.generatedText) img.text = im.generatedText
      return img
    })
    .filter(im => im.url)
  if (images.length === 0) throw new AppSdkError('AI_IMAGE_EMPTY', 'ai.generateImage: agent 返回成功但没有图片')
  const result: AiImageResult = { images, agent }
  if (typeof task?.id === 'string') result.taskId = task.id
  if (typeof out?.modelVersion === 'string') result.model = out.modelVersion
  if (out?.metadata !== undefined) result.metadata = out.metadata
  if (out?.usage !== undefined) result.usage = out.usage
  return result
}

// ---------- platform driver ----------
function platformAi(cfg: PlatformConfig): AiClient {
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
  /** aiBaseUrl 是 `{origin}/v1`；Function 的非 OpenAI 端点挂在 origin 下 */
  const functionBase = cfg.aiBaseUrl.replace(/\/v1$/, '')
  return {
    async chat(messages, opts) {
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(buildBody(cfg, messages, opts, false)), signal: opts?.signal,
      })
      if (!res.ok) await throwHttpError(res, 'ai.chat')
      const json: any = await res.json()
      const choice = json?.choices?.[0]
      const msg = choice?.message
      const content = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : ''
      return {
        content,
        model: typeof json?.model === 'string' ? json.model : undefined,
        usage: parseUsage(json?.usage),
        toolCalls: parseToolCalls(msg?.tool_calls),
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      }
    },
    async json(messages, opts) {
      return jsonWithRetry((msgs, o) => this.chat(msgs, o), messages, opts)
    },
    stream(messages, opts) {
      // 传了 tools 也只会流出空内容（下面只解析 delta.content），与其让页面渲染空白，不如当场报错
      if ((opts as AiChatOptions | undefined)?.tools?.length) {
        throw new AppSdkError('AI_STREAM_TOOLS_UNSUPPORTED', 'ai.stream 不支持工具调用：改用 ai.runTools（自动执行）或 ai.chat（自己处理 toolCalls）')
      }
      const start = async (): Promise<ReadableStream<Uint8Array>> => {
        const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/chat/completions`, {
          method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(buildBody(cfg, messages, opts, true)), signal: opts?.signal,
        })
        if (!res.ok) await throwHttpError(res, 'ai.stream')
        if (!res.body) throw new AppSdkError('EMPTY_BODY', 'ai.stream: response has no body')
        return res.body
      }
      const state: { usage?: AiUsage; content: string; finishReason?: string } = { content: '' }
      const iterate = async function* (): AsyncGenerator<string> {
        for await (const ev of parseSseEvents(await start())) {
          if (ev.usage) state.usage = ev.usage
          if (ev.finishReason) state.finishReason = ev.finishReason
          if (ev.delta !== undefined) { state.content += ev.delta; yield ev.delta }
        }
      }
      return {
        [Symbol.asyncIterator]: iterate,
        get usage() { return state.usage },
        get content() { return state.content },
        get finishReason() { return state.finishReason },
      }
    },
    runTools(messages, opts) {
      return runToolsLoop((msgs, o) => this.chat(msgs, o), messages, opts)
    },
    async embed(text, opts) {
      const r = await this.embedMany([text], opts)
      const v = r.vectors[0]
      if (!v) throw new AppSdkError('AI_EMPTY_EMBEDDING', 'ai.embed: 服务端没有返回向量')
      return v
    },
    async embedMany(texts, opts) {
      if (texts.length === 0) return { vectors: [] }
      const body: Record<string, unknown> = { model: opts?.model ?? cfg.aiEmbedModel, input: texts, encoding_format: 'float' }
      if (opts?.dimensions !== undefined) body.dimensions = opts.dimensions
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/embeddings`, { method: 'POST', headers, body: JSON.stringify(body), signal: opts?.signal })
      if (!res.ok) await throwHttpError(res, 'ai.embed')
      const json: any = await res.json()
      const data: any[] = Array.isArray(json?.data) ? json.data : []
      // 按 index 归位（服务端可能乱序返回）；用 fill 建成密集数组，否则下面的缺漏检查会跳过空洞
      const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(texts.length).fill(undefined)
      data.forEach((d, i) => {
        const idx = typeof d?.index === 'number' ? d.index : i
        // 空数组也算没拿到：放过去会被当成合法向量写进库，之后永远检索不到
        if (idx >= 0 && idx < texts.length && Array.isArray(d?.embedding) && d.embedding.length > 0) vectors[idx] = d.embedding
      })
      const missing = vectors.findIndex(v => v === undefined)
      if (missing >= 0) throw new AppSdkError('AI_EMPTY_EMBEDDING', `ai.embedMany: 第 ${String(missing)} 条文本没拿到向量（期望 ${String(texts.length)} 条，实际 ${String(data.length)} 条）`)
      return { vectors: vectors as number[][], model: typeof json?.model === 'string' ? json.model : undefined, usage: parseUsage(json?.usage) }
    },
    async ocr(file, opts) {
      const bytes = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : file
      const addOns = (opts.features ?? []).reduce((acc, f) => acc | (OCR_FLAGS[f] ?? 0), 0)
      const body: Record<string, unknown> = { filename: opts.filename, data: toBase64(bytes), addOns }
      if (opts.model) body.model = opts.model
      if (opts.queryFields?.length) body.queryFields = opts.queryFields
      const res = await cfg.fetchImpl(`${functionBase}/document-intelligence/analyze`, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      if (!res.ok) await throwHttpError(res, 'ai.ocr')
      return parseOcrResult(await res.json())
    },
    async models() {
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/models`, { method: 'GET', headers: { authorization: headers.authorization } })
      if (!res.ok) await throwHttpError(res, 'ai.models')
      const json: any = await res.json()
      const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
      return list.map(m => (typeof m === 'string' ? m : m?.id)).filter((id): id is string => typeof id === 'string')
    },
    async generateImage(opts) {
      if (!opts?.prompt?.trim()) throw new AppSdkError('AI_IMAGE_PROMPT_REQUIRED', 'ai.generateImage: prompt 不能为空')
      const agent = opts.agent ?? cfg.aiImageAgent ?? DEFAULT_IMAGE_AGENT
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/agents/${encodeURIComponent(agent)}/tasks`, {
        method: 'POST', headers, body: JSON.stringify({ input: buildImageInput(agent, opts) }), signal: opts.signal,
      })
      if (!res.ok) await throwHttpError(res, 'ai.generateImage')
      return parseImageTask(agent, await res.json())
    },
    async agents() {
      const res = await cfg.fetchImpl(`${cfg.aiBaseUrl}/agents`, { method: 'GET', headers: { authorization: headers.authorization } })
      if (!res.ok) await throwHttpError(res, 'ai.agents')
      const json: any = await res.json()
      const list: any[] = Array.isArray(json?.data) ? json.data : []
      return list.filter(a => typeof a?.id === 'string').map(a => ({ id: a.id, name: a.name ?? undefined, description: a.description ?? undefined, version: a.version ?? undefined, iconUrl: a.iconUrl ?? undefined, type: a.type ?? undefined }))
    },
  }
}

const NOT_CONFIGURED = 'AI is only available with the platform driver: set CHATU_DATA_URL/CHATU_APP_KEY (or CHATU_AI_URL) — copied from the Builder publish panel; there is no memory/byo fallback for LLM calls'

function notConfigured(): AiClient {
  const fail = () => { throw new AppSdkError('AI_NOT_CONFIGURED', NOT_CONFIGURED) }
  return {
    chat: async () => fail(),
    json: async () => fail(),
    stream: () => ({ [Symbol.asyncIterator]: async function* () { fail() }, usage: undefined, content: '', finishReason: undefined }),
    runTools: async () => fail(),
    embed: async () => fail(),
    embedMany: async () => fail(),
    ocr: async () => fail(),
    models: async () => fail(),
    generateImage: async () => fail(),
    agents: async () => fail(),
  }
}

let cached: { key: string; fetchImpl?: typeof fetch; client: AiClient } | null = null

/** 按当前配置取 AI 客户端（惰性、缓存；configure() 后自动重建） */
export function getAi(): AiClient {
  const cfg = resolveAiConfig()
  const key = cfg ? `platform|${cfg.aiBaseUrl}|${cfg.aiModel ?? ''}|${cfg.aiEmbedModel}|${cfg.aiImageAgent ?? ''}|${cfg.apiKey.slice(-4)}` : 'none'
  const fetchImpl = cfg?.fetchImpl
  if (!cached || cached.key !== key || cached.fetchImpl !== fetchImpl) cached = { key, fetchImpl, client: cfg ? platformAi(cfg) : notConfigured() }
  return cached.client
}

/** 便捷单例：`import { ai } from '@chatu-ai/app-sdk'` */
export const ai: AiClient = {
  chat: (m, o) => getAi().chat(m, o),
  json: (m, o) => getAi().json(m, o),
  stream: (m, o) => getAi().stream(m, o),
  runTools: (m, o) => getAi().runTools(m, o),
  embed: (t, o) => getAi().embed(t, o),
  embedMany: (t, o) => getAi().embedMany(t, o),
  ocr: (f, o) => getAi().ocr(f, o),
  models: () => getAi().models(),
  generateImage: o => getAi().generateImage(o),
  agents: () => getAi().agents(),
}
