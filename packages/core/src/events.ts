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

export const BuilderEvent = z.discriminatedUnion('kind', [
  MessageEvent, TaskCardEvent, FileDiffEvent, PreviewEvent, VersionEvent, DoneEvent,
])
export type BuilderEvent = z.infer<typeof BuilderEvent>
