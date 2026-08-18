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
  /** dev server：running 且 !ready = 首屏编译中（1c 机型冷启动可能 1–2 分钟） */
  devServer?: { running: boolean; ready?: boolean; startingForMs?: number | null; lastError?: string | null } | null
  /** runtime 内是否仍有生成在跑（上一轮连接中断后后台继续）：xid 可用于取消 */
  agent?: { executing: boolean; xid?: string | null; sinceMs?: number | null } | null
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

export type FunctionProvider = 'aliyun-fc' | 'tencent-scf' | 'volc-vefaas'
/** 函数计算部署（技术方案 17）：凭据二选一 credentialId（凭据库 aliyun/tencent/volcengine）或 accessKeyId+accessKeySecret */
export interface FunctionDeployInput {
  provider: FunctionProvider
  /** 函数/应用名：字母开头，字母数字与短横线，2-63 位 */
  name: string
  /** 地域，如 cn-hangzhou / ap-guangzhou / cn-beijing */
  region: string
  credentialId?: string
  accessKeyId?: string
  accessKeySecret?: string
  save?: boolean
  label?: string
  /** volc-vefaas 新建应用时的 API 网关名 */
  gatewayName?: string
  memoryMb?: number
  includeAppEnv?: boolean
  includeDataAccess?: boolean
}
export interface FunctionDeployResult {
  ok: boolean
  error?: string
  message?: string
  state?: string
  provider?: string
  name?: string
  region?: string
  url?: string
  consoleUrl?: string
  output?: string
  envVarsApplied?: number
  envVarsFailed?: string[]
  credentialId?: string | null
}
export type FunctionDeployStreamEvent = { type: 'log'; line: string } | { type: 'result'; result: FunctionDeployResult }
export type DeployStreamEvent = { type: 'log'; line: string } | { type: 'result'; result: DeployResult }
export type GitPushStreamEvent = { type: 'log'; line: string } | { type: 'result'; result: GitPushResult }
export interface DeployInput {
  provider: 'edgeone'
  projectName: string
  /** EdgeOne 部署区域：global（默认，含中国大陆可用）| overseas */
  area?: 'global' | 'overseas'
  credentialId?: string
  token?: string
  save?: boolean
  label?: string
  env?: 'production' | 'preview'
  includeAppEnv?: boolean
  includeDataAccess?: boolean
  /** 线上数据驱动：platform（默认，平台托管 Data API）| edgeone（EdgeOne Pages Blob，写 CHATU_DATA_DRIVER=edgeone） */
  dataDriver?: 'platform' | 'edgeone'
}
export interface DeployResult {
  ok: boolean
  error?: string
  state?: string
  projectName?: string
  env?: string
  url?: string
  consoleUrl?: string
  output?: string
  envVarsApplied?: number
  envVarsFailed?: string[]
  credentialId?: string | null
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
    /** 生成预览分享链接（非所有者可看；沙箱需在运行）；默认 24h，最长 7 天 */
    share(conversationId: string, ttlHours?: number): Promise<{ url: string; token: string; expiresAt: string }>
    revokeShare(conversationId: string, token: string): Promise<{ ok: boolean }>
    /** 重启 dev server（clean=true 先清 .next/.turbo 构建缓存）；服务端立即返回，就绪状态用 status().devServer.ready 轮询 */
    restartDevServer(conversationId: string, opts?: { clean?: boolean }): Promise<{ ok: boolean; ready?: boolean; cleaned?: boolean }>
    /** 休眠：保存快照后关闭 Pod（下次进入/发消息自动唤醒） */
    hibernate(conversationId: string): Promise<{ ok: boolean; state?: string; skipped?: boolean }>
    /** 强制关闭 Pod：不做新快照，立即删除（沙箱卡死时用；保留已有快照） */
    terminate(conversationId: string): Promise<{ ok: boolean; state?: string }>
  }
  versions: {
    list(conversationId: string, opts?: { limit?: number }): Promise<VersionInfo[]>
    restore(conversationId: string, sha: string): Promise<void>
  }
  files: {
    /** 文件树：默认只返回 path 的直接子项（depth=0），按需逐层展开；depth 最多 3 */
    tree(conversationId: string, opts?: { path?: string; ref?: string; depth?: number }): Promise<FileNode[]>
    read(conversationId: string, path: string, opts?: { ref?: string }): Promise<string>
    downloadUrl(conversationId: string): string
    /** 原样下载单个文件（图片/PDF 等预览用），返回 Blob 与 content-type */
    download(conversationId: string, path: string): Promise<{ blob: Blob; contentType: string }>
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
    /** 推送到 Git（SSE 进度版）：逐行 log 事件 + 最终 result；沙箱未运行时 result.error=SANDBOX_NOT_RUNNING */
    pushGitStream(conversationId: string, input: GitPushInput, opts?: { signal?: AbortSignal }): AsyncIterable<GitPushStreamEvent>
    /** 一键部署（P1：EdgeOne Pages）；沙箱未运行时 ok=false, error='SANDBOX_NOT_RUNNING' */
    deploy(conversationId: string, input: DeployInput): Promise<DeployResult>
    /** 一键部署（流式进度）：逐条产出 log 行，最后一条为 result */
    deployStream(conversationId: string, input: DeployInput, opts?: { signal?: AbortSignal }): AsyncIterable<DeployStreamEvent>
    /** 部署到函数计算（阿里云 FC / 腾讯 SCF / 火山 veFaaS）：SSE 进度 + 结果 */
    deployFunctionStream(conversationId: string, input: FunctionDeployInput, opts?: { signal?: AbortSignal }): AsyncIterable<FunctionDeployStreamEvent>
  }
  /** 平台数据能力接入信息（技术方案 15）：线上部署所需环境变量；apiKey 为服务端密钥 */
  data: {
    access(conversationId: string): Promise<{ baseUrl?: string | null; apiKey: string; envs: string[]; envVars: Record<string, string | null> }>
    /** 本月用量：dev/prod 原始计量与折算点数估算、只读状态、单价 */
    usage(conversationId: string): Promise<DataUsage>
    /** 资源面板：KV 浏览/编辑（经服务端代理，用户鉴权） */
    kv: {
      list(conversationId: string, opts?: { env?: 'dev' | 'prod'; prefix?: string; cursor?: string | null; limit?: number }): Promise<{ ok: boolean; keys: string[]; nextCursor: string | null }>
      get(conversationId: string, key: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; key: string; value: unknown; exists: boolean; ttl?: number | null }>
      set(conversationId: string, key: string, value: unknown, opts?: { env?: 'dev' | 'prod'; ex?: number }): Promise<{ ok: boolean }>
      remove(conversationId: string, key: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; removed?: boolean }>
    }
    /** 资源面板：文档集合浏览（技术方案 19） */
    db: {
      collections(conversationId: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; collections: Array<{ name: string; count: number }> }>
      query(conversationId: string, collection: string, opts?: { env?: 'dev' | 'prod'; filter?: Record<string, unknown>; sort?: Record<string, 1 | -1>; skip?: number; limit?: number }): Promise<{ ok: boolean; docs: Array<Record<string, unknown>>; total: number; nextSkip: number | null }>
      replace(conversationId: string, collection: string, id: string, doc: Record<string, unknown>, env?: 'dev' | 'prod'): Promise<{ ok: boolean; doc?: Record<string, unknown> }>
      remove(conversationId: string, collection: string, id: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; removed?: boolean }>
      drop(conversationId: string, collection: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; dropped?: boolean }>
    }
    /** 资源面板：对象存储浏览 */
    storage: {
      list(conversationId: string, opts?: { env?: 'dev' | 'prod'; prefix?: string; cursor?: string | null; limit?: number }): Promise<{ ok: boolean; items: Array<{ key: string; size: number; lastModified?: string | null }>; nextCursor: string | null }>
      sign(conversationId: string, key: string, opts?: { env?: 'dev' | 'prod'; expiresIn?: number; downloadName?: string }): Promise<{ ok: boolean; url: string }>
      uploadUrl(conversationId: string, key: string, opts?: { env?: 'dev' | 'prod'; contentType?: string; size?: number }): Promise<{ ok: boolean; url: string; method: 'PUT'; headers?: { contentType?: string } | null }>
      remove(conversationId: string, key: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean }>
    }
    /** 复制命名空间（默认 dev→prod） */
    promote(conversationId: string, input?: { from?: 'dev' | 'prod'; to?: 'dev' | 'prod'; overwrite?: boolean; kv?: boolean; storage?: boolean; db?: boolean }): Promise<{ ok: boolean; error?: string; kv?: { copied: number; skipped: number } | null; storage?: { copied: number; skipped: number; bytes: number } | null; db?: { copied: number; skipped: number } | null }>
    /** 导出数据：KV 键值 + 对象清单（1 小时下载地址） */
    export(conversationId: string, env?: 'dev' | 'prod'): Promise<{ ok: boolean; env: string; kv: Array<{ key: string; value: unknown; ttl?: number | null }>; storage: Array<{ key: string; size: number; url?: string | null }> }>
  }
  logs: {
    /** dev server 最近日志（沙箱未运行返回空） */
    tail(conversationId: string, lines?: number): Promise<{ lines: string[] }>
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
      share: (id, ttlHours) => req(`/${id}/preview-share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttlHours }) }),
      revokeShare: (id, token) => req(`/${id}/preview-share/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
      restartDevServer: (id, opts) => req(`/${id}/devserver/restart?clean=${opts?.clean ? 'true' : 'false'}`, { method: 'POST' }),
      hibernate: id => req(`/sandbox/${id}/hibernate`, { method: 'POST' }),
      terminate: id => req(`/sandbox/${id}/terminate`, { method: 'POST' }),
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
        const r = await req<{ tree?: FileNode[] } | FileNode[]>(`/${id}/files?${qs({ path: opts?.path, ref: opts?.ref, depth: opts?.depth })}`)
        return Array.isArray(r) ? r : (r.tree ?? [])
      },
      read: (id, path, opts) => req<string>(`/${id}/files/read?${qs({ path, ...opts })}`),
      downloadUrl: id => `${restBase}/${id}/files/download`,
      download: async (id, path) => {
        const res = await doFetch(`${restBase}/${id}/files/download?path=${encodeURIComponent(path)}`, auth.apply({}))
        if (!res.ok) throw new BuilderApiError(res.status, await res.text().catch(() => ''))
        return { blob: await res.blob(), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
      },
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
      pushGitStream: (id, input, o) => readNamedSse<GitPushResult>(`${restBase}/${id}/export/git/stream`, auth.apply({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), signal: o?.signal }), doFetch),
      deploy: (id, input) => req(`/${id}/export/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
      deployFunctionStream: (id, input, o) => readNamedSse<FunctionDeployResult>(`${restBase}/${id}/export/deploy-function/stream`, auth.apply({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), signal: o?.signal }), doFetch),
      deployStream: (id, input, o) => readNamedSse<DeployResult>(`${restBase}/${id}/export/deploy/stream`, auth.apply({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), signal: o?.signal }), doFetch),
    },
    data: {
      access: id => req(`/${id}/data-access`),
      usage: id => req(`/${id}/data-usage`),
      kv: {
        list: (id, o) => req(`/${id}/data/kv?${qs({ env: o?.env, prefix: o?.prefix, cursor: o?.cursor ?? undefined, limit: o?.limit })}`),
        get: (id, key, env) => req(`/${id}/data/kv/${encPath(key)}?${qs({ env })}`),
        set: (id, key, value, o) => req(`/${id}/data/kv/${encPath(key)}?${qs({ env: o?.env })}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, ex: o?.ex }) }),
        remove: (id, key, env) => req(`/${id}/data/kv/${encPath(key)}?${qs({ env })}`, { method: 'DELETE' }),
      },
      db: {
        collections: (id, env) => req(`/${id}/data/db?${qs({ env })}`),
        query: (id, coll, o) => req(`/${id}/data/db/${encPath(coll)}/query?${qs({ env: o?.env })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: o?.filter, sort: o?.sort, skip: o?.skip, limit: o?.limit }) }),
        replace: (id, coll, docId, doc, env) => req(`/${id}/data/db/${encPath(coll)}/${encPath(docId)}?${qs({ env })}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }),
        remove: (id, coll, docId, env) => req(`/${id}/data/db/${encPath(coll)}/${encPath(docId)}?${qs({ env })}`, { method: 'DELETE' }),
        drop: (id, coll, env) => req(`/${id}/data/db/${encPath(coll)}?${qs({ env })}`, { method: 'DELETE' }),
      },
      storage: {
        list: (id, o) => req(`/${id}/data/storage?${qs({ env: o?.env, prefix: o?.prefix, cursor: o?.cursor ?? undefined, limit: o?.limit })}`),
        sign: (id, key, o) => req(`/${id}/data/storage/sign?${qs({ env: o?.env })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, expiresIn: o?.expiresIn, downloadName: o?.downloadName }) }),
        uploadUrl: (id, key, o) => req(`/${id}/data/storage/upload-url?${qs({ env: o?.env })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, contentType: o?.contentType, size: o?.size }) }),
        remove: (id, key, env) => req(`/${id}/data/storage/${encPath(key)}?${qs({ env })}`, { method: 'DELETE' }),
      },
      promote: (id, input) => req(`/${id}/data/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) }),
      export: (id, env) => req(`/${id}/data/export?env=${env ?? 'prod'}`),
    },
    logs: {
      tail: async (id, lines) => {
        const r = await req<{ lines?: string[] } | string[]>(`/${id}/logs?tail=${lines ?? 200}`)
        return { lines: Array.isArray(r) ? r : (r.lines ?? []) }
      },
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

/** 读取带 event: 名的 SSE（log / result） */
async function* readNamedSse<R>(url: string, init: RequestInit, doFetch: typeof fetch): AsyncIterable<{ type: 'log'; line: string } | { type: 'result'; result: R }> {
  const res = await doFetch(url, init)
  if (!res.ok || !res.body) throw new BuilderApiError(res.status, await res.text().catch(() => ''))
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue }
        if (!line.startsWith('data:')) { if (line === '') eventName = eventName; continue }
        const data = line.slice(5).trim()
        if (!data) continue
        let payload: any = data
        try { payload = JSON.parse(data) } catch { /* raw */ }
        if (eventName === 'log') yield { type: 'log', line: String(payload?.line ?? payload) }
        else if (eventName === 'result') yield { type: 'result', result: normalizeKeys(payload) as R }
        eventName = ''
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 服务端 SSE 序列化可能是 PascalCase（Ok/Url）——统一成 camelCase */
function normalizeKeys(obj: any): any {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  if ('ok' in obj || !('Ok' in obj)) return obj
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k.charAt(0).toLowerCase() + k.slice(1)] = v
  return out
}

function encPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function qs(obj?: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined && v !== null) p.set(k, String(v))
  return p.toString()
}
