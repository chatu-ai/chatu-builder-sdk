/**
 * A2A 原始事件 → BuilderEvent 解析（03 §2 冻结 schema 的映射实现）。
 * 未知/不完整事件返回 null（前向兼容：忽略而非报错——N4 版本偏斜策略）。
 */
import { BuilderEvent } from './events'

interface RawA2A {
  taskId?: string
  task?: { id?: string; status?: { state?: string } }
  status?: { state?: string }
  artifact?: { artifactId?: string; name?: string; parts?: Array<{ kind?: string; text?: string }> }
  metadata?: Record<string, any>
}

export function parseBuilderEvent(raw: unknown): BuilderEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as RawA2A
  const md = r.metadata ?? {}
  const xid = r.taskId ?? r.task?.id
  if (!xid) return null
  const seq: number = typeof md.seq === 'number' ? md.seq : 0

  let candidate: unknown = null

  if (md.sandbox) {
    candidate = { kind: 'ack', xid, seq: 0, sandbox: md.sandbox }
  } else if (md.taskCard) {
    candidate = { kind: 'taskCard', xid, seq, ...md.taskCard }
  } else if (md.preview) {
    candidate = { kind: 'preview', xid, seq, ...md.preview }
  } else if (md.version) {
    candidate = { kind: 'version', xid, seq, ...md.version }
  } else if (md.file && r.artifact) {
    candidate = {
      kind: 'fileDiff', xid, seq,
      path: r.artifact.name ?? '',
      action: md.file.action,
      diff: r.artifact.parts?.find(p => p.kind === 'text')?.text,
      bytes: md.file.bytes ?? 0,
      truncated: md.file.truncated ?? false,
    }
  } else if (md.text) {
    candidate = { kind: 'message', xid, seq, role: md.role ?? 'assistant', text: md.text }
  } else {
    const state = r.status?.state ?? r.task?.status?.state
    if (state === 'completed' || state === 'failed' || state === 'canceled') {
      candidate = { kind: 'done', xid, seq, state, error: md.error }
    }
  }

  if (candidate === null) return null
  const parsed = BuilderEvent.safeParse(candidate)
  return parsed.success ? parsed.data : null
}
