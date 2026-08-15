/**
 * agent3 SSE（BuilderController create/connect 直通流）→ BuilderEvent 翻译。
 * P0 步骤一形态：服务端不做翻译，前端按 chatuse Message 形态推导事件（03 §2 语义）。
 * 步骤二切 A2A 时本模块保留为 REST/SSE 传输的实现之一（同一 BuilderEvent 出口）。
 *
 * agent3 Message: { type: step|chunk|complete|error|status|input|dialog, content, sequenceNumber, xid }
 *   content = Claude Agent SDK 原始消息（assistant text/tool_use、user tool_result、result...）
 */
import { BuilderEvent } from './events'

interface Agent3Message {
  type?: string
  xid?: string
  sequenceNumber?: number
  content?: any
}

/** 工具名 → 任务卡标签（规则化，07 §4 taskCardMapper 的前端镜像） */
const TOOL_LABELS: Record<string, string> = {
  Bash: '执行命令',
  Write: '写入文件',
  Edit: '修改文件',
  MultiEdit: '批量修改',
  Read: '读取文件',
  Glob: '查找文件',
  Grep: '搜索代码',
  WebSearch: '搜索资料',
  WebFetch: '获取网页',
  Task: '子任务',
}

/**
 * 有状态翻译器：一个 xid 一个实例（跟踪 tool_use_id → 任务卡 id，用于 done 状态回填）
 */
export class Agent3Translator {
  private readonly toolCards = new Map<string, string>()

  /**
   * 翻译一条 SSE data 行（JSON 文本或服务端自产的 builder-ack/created-response）
   * 返回 0..n 个事件（一条 assistant 消息可能含 text + 多个 tool_use）
   */
  translate(raw: unknown): BuilderEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const m = raw as Agent3Message & { seq?: number; sandbox?: unknown }

    // 服务端流前事件（BuilderController）
    if (m.type === 'builder-ack' && m.sandbox) {
      const parsed = BuilderEvent.safeParse({ kind: 'ack', xid: 'pending', seq: 0, sandbox: m.sandbox })
      return parsed.success ? [parsed.data] : []
    }
    if (m.type === 'created-response') return [] // xid 由调用方从此事件取出，不产出 BuilderEvent

    const xid = m.xid
    const seq = m.sequenceNumber
    if (!xid || typeof seq !== 'number') return []
    const out: unknown[] = []

    switch (m.type) {
      case 'chunk':
      case 'step':
        out.push(...this.fromSdkMessage(xid, seq, m.content))
        break
      case 'complete':
        out.push({ kind: 'done', xid, seq, state: this.resultState(m.content) })
        break
      case 'error':
        out.push({ kind: 'done', xid, seq, state: 'failed', error: errorText(m.content) })
        break
      case 'status':
        break // 系统状态：P0 不映射（后续可映射 task_updated → taskCard）
      default:
        break
    }

    return out
      .map(e => BuilderEvent.safeParse(e))
      .filter((r): r is { success: true; data: BuilderEvent } => r.success)
      .map(r => r.data)
  }

  private fromSdkMessage(xid: string, seq: number, content: any): unknown[] {
    const events: unknown[] = []
    const message = content?.message ?? content
    const blocks: any[] = Array.isArray(message?.content) ? message.content : []
    const role = message?.role ?? content?.type

    for (const block of blocks) {
      if (block?.type === 'text' && role === 'assistant' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'message', xid, seq, role: 'assistant', text: block.text })
      } else if (block?.type === 'tool_use') {
        const cardId = `tc_${block.id ?? seq}`
        this.toolCards.set(block.id, cardId)
        events.push({
          kind: 'taskCard', xid, seq, id: cardId,
          label: TOOL_LABELS[block.name] ?? block.name ?? '执行工具',
          state: 'running',
          detail: describeInput(block.name, block.input),
        })
        // 文件变更事件（Write/Edit）
        const path = block.input?.file_path ?? block.input?.path
        if ((block.name === 'Write' || block.name === 'Edit' || block.name === 'MultiEdit') && typeof path === 'string') {
          events.push({
            kind: 'fileDiff', xid, seq, path: relPath(path),
            action: block.name === 'Write' ? 'create' : 'modify',
            bytes: typeof block.input?.content === 'string' ? block.input.content.length : 0,
            truncated: false,
          })
        }
      } else if (block?.type === 'tool_result') {
        const cardId = this.toolCards.get(block.tool_use_id)
        if (cardId) {
          events.push({
            kind: 'taskCard', xid, seq, id: cardId,
            label: '', // upsert 时保留原 label（reducer 以 id 合并；空 label 由 reducer 忽略）
            state: block.is_error ? 'failed' : 'done',
          })
        }
      }
    }
    return events
  }

  private resultState(content: any): 'completed' | 'failed' | 'canceled' {
    const subtype = content?.subtype ?? content?.result?.subtype
    if (subtype === 'success') return 'completed'
    if (typeof subtype === 'string' && subtype.includes('cancel')) return 'canceled'
    if (content?.is_error) return 'failed'
    return 'completed'
  }
}

function describeInput(tool: string, input: any): string | undefined {
  if (!input) return undefined
  if (tool === 'Bash' && typeof input.command === 'string') return input.command.slice(0, 80)
  const p = input.file_path ?? input.path ?? input.pattern
  return typeof p === 'string' ? relPath(p).slice(0, 80) : undefined
}

function relPath(p: string): string {
  return p.replace(/^\/workspace\//, '')
}

function errorText(content: any): string {
  if (typeof content === 'string') return content
  return content?.message ?? content?.error ?? 'unknown error'
}
