/**
 * BuilderClient —— 08 §2 冻结 API 面的实现。
 * A2A 传输层由宿主注入（chat-web 传入 libs/a2a-client 的包装），core 不重写传输。
 */
import type { AuthProvider } from './auth'
import type { BuilderEvent, SandboxState } from './events'
import { parseBuilderEvent } from './parse'
import { resilientStream, type ResilienceOptions } from './resume'

export interface A2ATransport {
  /** message/stream：发起生成，产出原始 A2A 事件 */
  stream(conversationId: string, prompt: string, opts?: { agentId?: string; attachments?: unknown[] }): AsyncIterable<unknown>
  /** tasks/resubscribe：按 task 重连（服务端回放 seq > lastSeq） */
  resubscribe(xid: string, lastSeq: number): AsyncIterable<unknown>
  /** tasks/cancel */
  cancel(xid: string): Promise<void>
}

export interface BuilderClientOptions {
  /** REST 前缀，如 https://api.example.com/web/builder */
  restBase: string
  transport: A2ATransport
  auth: AuthProvider
  fetchImpl?: typeof fetch
  resilience?: ResilienceOptions
  /**
   * 原始传输事件 → BuilderEvent 解析器。默认 A2A 解析；
   * 传输层已产出 BuilderEvent 时（如 agent3 SSE 直通）传 identity：`e => e as BuilderEvent`
   */
  parse?: (raw: unknown) => BuilderEvent | null
}

export interface SandboxStatus {
  state: SandboxState
  previewUrl?: string
  devServer?: { running: boolean; lastError?: string }
}
export interface VersionInfo { sha: string; message: string; filesChanged: number; createdAt?: string }
export interface FileNode { path: string; type: 'file' | 'dir'; children?: FileNode[] }

export interface BuilderClient {
  chat: {
    stream(conversationId: string, prompt: string, opts?: { agentId?: string; attachments?: unknown[] }): AsyncIterable<BuilderEvent>
    resubscribe(conversationId: string, xid: string, lastSeq: number): AsyncIterable<BuilderEvent>
    cancel(conversationId: string, xid: string): Promise<void>
  }
  sandbox: {
    status(conversationId: string): Promise<SandboxStatus>
    heartbeat(conversationId: string, opts: { visible: boolean }): Promise<void>
    /** 一次性预览 token（06 §6.1）：返回可直接作 iframe src 的带 ?t= 的 URL */
    previewToken(conversationId: string): Promise<{ token: string; previewUrl: string }>
  }
  versions: {
    list(conversationId: string, opts?: { limit?: number }): Promise<VersionInfo[]>
    restore(conversationId: string, sha: string): Promise<void>
  }
  files: {
    tree(conversationId: string, opts?: { path?: string; ref?: string }): Promise<FileNode[]>
    read(conversationId: string, path: string, opts?: { ref?: string }): Promise<string>
    downloadUrl(conversationId: string): string
  }
}

export function createBuilderClient(options: BuilderClientOptions): BuilderClient {
  const { restBase, transport, auth } = options
  const doFetch = options.fetchImpl ?? fetch
  const parse = options.parse ?? parseBuilderEvent

  async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(`${restBase}${path}`, auth.apply(init))
    if (!res.ok) throw new BuilderApiError(res.status, await res.text().catch(() => ''))
    const ct = res.headers.get('content-type') ?? ''
    return (ct.includes('json') ? res.json() : res.text()) as Promise<T>
  }

  /** 把原始 A2A 迭代器包装成解析后的迭代器 */
  async function* parsed(src: AsyncIterable<unknown>): AsyncIterable<BuilderEvent | null> {
    for await (const raw of src) yield parse(raw)
  }

  return {
    chat: {
      stream(conversationId, prompt, opts) {
        // xid 在 ack 事件中获知，用于断线 reopen
        let xid: string | undefined
        const base = resilientStream({
          open: () => parsed(transport.stream(conversationId, prompt, opts)),
          reopen: lastSeq => {
            if (!xid) throw new Error('cannot resubscribe before ack (xid unknown)')
            return parsed(transport.resubscribe(xid, lastSeq))
          },
        }, options.resilience)
        // 旁路捕获 xid
        return (async function* () {
          for await (const ev of base) {
            if (ev.kind === 'ack') xid = ev.xid
            yield ev
          }
        })()
      },
      resubscribe(_conversationId, xid, lastSeq) {
        return resilientStream({
          open: () => parsed(transport.resubscribe(xid, lastSeq)),
          reopen: seq => parsed(transport.resubscribe(xid, seq)),
        }, options.resilience)
      },
      cancel: (_conversationId, xid) => transport.cancel(xid),
    },
    sandbox: {
      status: id => req(`/sandbox/${id}/status`),
      heartbeat: (id, opts) => req(`/sandbox/${id}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      }),
      previewToken: id => req(`/${id}/preview-token`),
    },
    versions: {
      // 服务端形状：{ versions: VersionInfo[] }（runtime 透传）
      list: async (id, opts) => {
        const r = await req<{ versions?: VersionInfo[] } | VersionInfo[]>(`/${id}/versions${opts?.limit ? `?limit=${opts.limit}` : ''}`)
        return Array.isArray(r) ? r : (r.versions ?? [])
      },
      restore: async (id, sha) => { await req(`/${id}/versions/${sha}/restore`, { method: 'POST' }) },
    },
    files: {
      // 服务端形状：{ tree: FileNode[] }
      tree: async (id, opts) => {
        const r = await req<{ tree?: FileNode[] } | FileNode[]>(`/${id}/files?${qs(opts)}`)
        return Array.isArray(r) ? r : (r.tree ?? [])
      },
      read: (id, path, opts) => req<string>(`/${id}/files/read?${qs({ path, ...opts })}`),
      downloadUrl: id => `${restBase}/${id}/files/download`,
    },
  }
}

export class BuilderApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`builder api ${status}: ${body.slice(0, 200)}`)
  }
}

function qs(obj?: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) p.set(k, v)
  return p.toString()
}
