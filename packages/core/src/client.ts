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

export type CredentialScope = 'organization' | 'user' | 'conversation'
export interface CredentialView {
  id: string
  scope: CredentialScope
  provider: string
  label: string
  hint?: string | null
  meta?: Record<string, unknown> | null
  createdTime: string
  lastUsedTime?: string | null
  readOnly: boolean
}
export interface DeploySettingView {
  target: string
  credentialId?: string | null
  config: Record<string, unknown>
  lastRunTime?: string | null
  lastRunStatus?: string | null
  lastRunMessage?: string | null
  lastRunUrl?: string | null
  updatedTime: string
}
export interface GitPushInput {
  remoteUrl: string
  branch?: string
  /** 二选一：凭据库 id */
  credentialId?: string
  /** 二选一：仅本次使用的令牌；save=true 时同时存为用户级凭据 */
  token?: string
  username?: string
  save?: boolean
  label?: string
  force?: boolean
  commitMessage?: string
}
export interface GitPushResult {
  ok: boolean
  error?: string
  state?: string
  remoteUrl?: string
  branch?: string
  sha?: string
  output?: string
  webUrl?: string
  credentialId?: string | null
}

export interface DataUsageEnv { raw: Record<string, number>; points: number }
export interface DataUsage {
  ok: boolean
  month?: string
  readOnly?: boolean
  dev?: DataUsageEnv
  prod?: DataUsageEnv
  rates?: Record<string, number>
  error?: string
}

export interface BuilderClient {
  chat: {
    stream(conversationId: string, prompt: string, opts?: { agentId?: string; attachments?: unknown[] }): AsyncIterable<BuilderEvent>
    resubscribe(conversationId: string, xid: string, lastSeq: number): AsyncIterable<BuilderEvent>
    cancel(conversationId: string, xid: string): Promise<void>
  }
  sandbox: {
    status(conversationId: string): Promise<SandboxStatus>
    heartbeat(conversationId: string, opts: { visible: boolean }): Promise<void | { ok?: boolean; state?: SandboxState | string }>
    /** 一次性预览 token（06 §6.1）：返回可直接作 iframe src 的带 ?t= 的 URL */
    previewToken(conversationId: string): Promise<{ token: string; previewUrl: string }>
    /** 唤醒/确保沙箱（休眠 → 恢复快照 → 起 dev server；不发起 agent 会话） */
    wake(conversationId: string): Promise<SandboxStatus>
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
  /** 凭据库（技术方案 14 §2）：列表脱敏，永不返回明文 */
  credentials: {
    list(conversationId?: string): Promise<CredentialView[]>
    save(input: { provider: string; label: string; secret: string; scope: 'user' | 'conversation'; conversationId?: string; meta?: Record<string, unknown> }): Promise<CredentialView>
    remove(id: string): Promise<void>
  }
  /** 设置库 + 发布动作 */
  deploy: {
    settings(conversationId: string): Promise<DeploySettingView[]>
    saveSetting(conversationId: string, input: { target: string; credentialId?: string | null; config?: Record<string, unknown> }): Promise<DeploySettingView>
    /** 推送到用户 Git 仓库；沙箱未运行时 ok=false, error='SANDBOX_NOT_RUNNING' */
    pushGit(conversationId: string, input: GitPushInput): Promise<GitPushResult>
  }
  /** 平台数据能力接入信息（技术方案 15）：线上部署所需环境变量；apiKey 为服务端密钥 */
  data: {
    access(conversationId: string): Promise<{ baseUrl?: string | null; apiKey: string; envs: string[]; envVars: Record<string, string | null> }>
    /** 本月用量：dev/prod 原始计量与折算点数估算、只读状态、单价 */
    usage(conversationId: string): Promise<DataUsage>
  }
  export: {
    /**
     * 导出应用源码 ZIP（含 Dockerfile/DEPLOY.md）。沙箱未运行时服务端返回 409 SANDBOX_NOT_RUNNING —— 调用方先 sandbox.wake()。
     * 返回 Blob 与建议文件名（取自 Content-Disposition）
     */
    zip(conversationId: string): Promise<{ blob: Blob; fileName: string }>
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
    if (!ct.includes('json')) return (await res.text()) as T
    const json: unknown = await res.json()
    return unwrapEnvelope<T>(json)
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
      wake: id => req(`/sandbox/${id}/wake`, { method: 'POST' }),
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
    credentials: {
      list: conversationId => req(`/credentials${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`),
      save: input => req('/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
      remove: async id => { await req(`/credentials/${id}`, { method: 'DELETE' }) },
    },
    deploy: {
      settings: id => req(`/${id}/deploy-settings`),
      saveSetting: (id, input) => req(`/${id}/deploy-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
      pushGit: (id, input) => req(`/${id}/export/git`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    },
    data: {
      access: id => req(`/${id}/data-access`),
      usage: id => req(`/${id}/data-usage`),
    },
    export: {
      zip: async id => {
        const res = await doFetch(`${restBase}/${id}/export/zip`, auth.apply({}))
        if (!res.ok) throw new BuilderApiError(res.status, await res.text().catch(() => ''))
        const cd = res.headers.get('content-disposition') ?? ''
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)
        const fileName = m?.[1] ? decodeURIComponent(m[1]) : 'app.zip'
        return { blob: await res.blob(), fileName }
      },
    },
  }
}

/**
 * Dapi.Web 结果过滤器会把 object 返回包成 { code, data, message }（ContentResult 直通不包）。
 * 统一拆信封：code !== 0 视为业务错误抛出；非信封形状原样返回。
 */
function unwrapEnvelope<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'code' in json && 'data' in json) {
    const env = json as { code: number; data: T; message?: string }
    if (env.code !== 0) throw new BuilderApiError(200, env.message ?? `api code ${env.code}`)
    return env.data
  }
  return json as T
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
