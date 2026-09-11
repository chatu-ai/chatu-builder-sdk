/**
 * Builder 事件 schema —— 单一事实源（003.技术方案/03 §2 的代码化）
 * 服务端 C# 侧使用由此导出的 JSON Schema 做对偶校验。
 * seq 作用域：单个 xid（任务）内单调递增（评审记录 R1）。
 */
import { z } from 'zod'

export const SandboxState = z.enum([
  'requested', 'creating', 'warming', 'ready', 'busy',
  'snapshotting', 'hibernated', 'resuming', 'recycled', 'failed',
])
export type SandboxState = z.infer<typeof SandboxState>

const base = z.object({
  xid: z.string(),
  seq: z.number().int().nonnegative(),
})

/** 流前确认事件（服务端自产，固定 seq=0，不参与去重排序——R17） */
export const AckEvent = base.extend({
  kind: z.literal('ack'),
  sandbox: z.object({
    sandboxId: z.string(),
    state: SandboxState,
    previewUrl: z.string().url().optional(),
  }),
})

export const MessageEvent = base.extend({
  kind: z.literal('message'),
  role: z.enum(['assistant', 'system']),
  text: z.string(),
})

export const TaskCardEvent = base.extend({
  kind: z.literal('taskCard'),
  id: z.string(),
  label: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  detail: z.string().optional(),
})

export const FileDiffEvent = base.extend({
  kind: z.literal('fileDiff'),
  path: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
  diff: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
})

export const PreviewEvent = base.extend({
  kind: z.literal('preview'),
  state: z.enum(['starting', 'ready', 'crashed']),
  url: z.string().url().optional(),
  error: z.string().nullable().optional(),
})

export const VersionEvent = base.extend({
  kind: z.literal('version'),
  sha: z.string(),
  message: z.string(),
  filesChanged: z.number().int().nonnegative(),
})

export const DoneEvent = base.extend({
  kind: z.literal('done'),
  state: z.enum(['completed', 'failed', 'canceled']),
  error: z.string().optional(),
})

/** 一个需要用户填写的环境变量（技术方案 32 §4.4） */
export const EnvRequestVar = z.object({
  /** 变量名，如 WECHAT_APP_ID */
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  /** 给用户看的说明（在哪里找到这个值） */
  label: z.string().optional(),
  /** 是否密钥（前端掩码输入；缺省按名字含 SECRET/KEY/TOKEN 判断） */
  secret: z.boolean().optional(),
  /** 是否必填，缺省 true */
  required: z.boolean().optional(),
})
export type EnvRequestVar = z.infer<typeof EnvRequestVar>

/**
 * 模型在回复里用 ```chatu-env 代码块声明「这一步需要用户配置环境变量」，
 * 客户端从消息文本里抽出来变成本事件，渲染成引导卡（步骤 + 回调域 + 内联保存），文本里不再显示原始 JSON。
 */
export const EnvRequestEvent = base.extend({
  kind: z.literal('envRequest'),
  /** 预设标识（wechat / wechat-mp / github …），前端据此带出后台配置步骤；自定义变量可不填 */
  preset: z.string().optional(),
  /** 卡片标题，如「配置微信扫码登录」 */
  title: z.string().optional(),
  vars: z.array(EnvRequestVar).min(1),
  /** 配好之后用户点「继续」时自动发送的话，缺省「已配置，继续」 */
  resume: z.string().optional(),
})
export type EnvRequestEvent = z.infer<typeof EnvRequestEvent>

export const BuilderEvent = z.discriminatedUnion('kind', [
  AckEvent, MessageEvent, TaskCardEvent, FileDiffEvent, PreviewEvent, VersionEvent, DoneEvent, EnvRequestEvent,
])
export type BuilderEvent = z.infer<typeof BuilderEvent>
