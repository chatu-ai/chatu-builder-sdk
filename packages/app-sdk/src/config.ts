/**
 * 驱动选择（技术方案 15 §1、33）：
 * - CHATU_DATA_URL + CHATU_APP_KEY（或 CHATU_CUSTOMER_API_KEY）→ platform（平台托管 Data API，开发期/线上都可用，按用量计费）
 * - CHATU_DATA_DRIVER=sqlite → sqlite（db / kv 落本地 SQLite 文件；auth / storage / ai 在有平台配置时仍走平台）
 * - 都没有 → memory（进程内存，重启即丢；本地开发/无配置降级）
 * 只在服务端使用（Route Handler / Server Component / Server Action）；密钥不得暴露给浏览器。
 */
export type DriverKind = 'platform' | 'byo' | 'memory' | 'edgeone' | 'sqlite'

/**
 * 应用的登录模式（技术方案 23）：
 * - `app`（默认）：应用自建用户体系（邮箱验证码 / 邮箱密码，首次登录自动注册）
 * - `channel`：直接使用应用所属渠道的账号登录，**不提供注册**（账号由渠道侧开通）
 * 由 CHATU_AUTH_MODE 或 configure({ authMode }) 指定；一个应用只用一种。
 */
export type AuthMode = 'app' | 'channel'

export interface PlatformConfig {
  kind: 'platform'
  baseUrl: string
  apiKey: string
  env: 'dev' | 'prod'
  fetchImpl: typeof fetch
  /** OpenAI 兼容的 LLM 中继地址（`{origin}/v1`）：CHATU_AI_URL 显式指定，否则由 CHATU_DATA_URL 去掉 `/data/v1` 推导 */
  aiBaseUrl: string
  /** 默认模型：CHATU_AI_MODEL → PRIMARY_MODEL（沙箱注入的平台默认模型）；都没有则不传，由服务端决定 */
  aiModel?: string
  /** 默认 embedding 模型：CHATU_AI_EMBED_MODEL，缺省 text-embedding-3-small（服务端要求显式传 model） */
  aiEmbedModel: string
  /** 默认生图 agent：CHATU_AI_IMAGE_AGENT；缺省由 ai.generateImage 用最便宜的 Seedream4 */
  aiImageAgent?: string
  /** 默认视频 agent：CHATU_AI_VIDEO_AGENT；缺省由 ai.generateVideo 用最便宜的 Seedance2Fast */
  aiVideoAgent?: string
  /**
   * auth.getSession() 的进程内缓存秒数（默认 30，0 关闭）。
   * 会话校验每个请求都会发生，缓存能显著减少计费的 auth 调用；代价是"停用用户"最多延迟这么久生效。
   * 覆盖：configure({ authSessionCacheSeconds }) 或环境变量 CHATU_AUTH_SESSION_CACHE。
   */
  authSessionCacheSeconds: number
  /** 登录模式（默认 app）：channel 时 auth.login() 走渠道账号登录，注册/验证码接口不可用 */
  authMode: AuthMode
}
export interface MemoryConfig { kind: 'memory' }
/** 自带云资源（模式 A）：REDIS_URL → KV；S3_* → 对象存储（腾讯云 COS / MinIO / AWS 等 S3 兼容） */
export interface ByoConfig {
  kind: 'byo'
  redisUrl?: string
  kvPrefix: string
  s3?: { endpoint?: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string; forcePathStyle: boolean }
}
/**
 * EdgeOne Pages Blob（部署到 EdgeOne 时可选）：kv 与 storage 都落在 Pages Blob（`@edgeone/pages-blob`）
 * - Pages 函数内免凭据；外部访问（如平台侧只读浏览）需 projectId + API token
 * - CHATU_DATA_DRIVER=edgeone 启用；store 名可用 CHATU_EDGEONE_KV_STORE / CHATU_EDGEONE_STORAGE_STORE 覆盖
 */
export interface EdgeoneConfig {
  kind: 'edgeone'
  kvStore: string
  storageStore: string
  projectId?: string
  token?: string
  /** 应用内代理读取路由前缀（storage.url() 返回 `${publicPathPrefix}/<key>`；模板内置 /_chatu/blob） */
  publicPathPrefix: string
}
/**
 * 本地 SQLite（技术方案 33；CHATU_DATA_DRIVER=sqlite）：db 与 kv 落到同一个 SQLite 文件，用 Node 内置 `node:sqlite`（≥ 22.13），零依赖。
 * 只适合单机单实例（Docker / 自己的服务器 / 本机），不能部署到 EdgeOne Pages / 云函数（无持久磁盘）。
 * 同时配了 CHATU_DATA_URL + CHATU_APP_KEY 时 `platform` 非空：auth / storage / ai 继续走平台。
 */
export interface SqliteConfig {
  kind: 'sqlite'
  /** 数据库文件路径（相对进程 cwd）：CHATU_SQLITE_PATH，默认 ./data/chatu.sqlite；父目录不存在时自动创建 */
  path: string
  platform: PlatformConfig | null
}
export type ResolvedConfig = PlatformConfig | ByoConfig | MemoryConfig | EdgeoneConfig | SqliteConfig

export const DEFAULT_SQLITE_PATH = './data/chatu.sqlite'

export interface ConfigureOptions {
  baseUrl?: string
  apiKey?: string
  env?: 'dev' | 'prod'
  driver?: DriverKind
  fetchImpl?: typeof fetch
  /** LLM 中继地址（默认由 baseUrl 推导） */
  aiBaseUrl?: string
  /** LLM 默认模型 */
  model?: string
  /** embedding 默认模型（缺省 text-embedding-3-small） */
  embedModel?: string
  /** 生图默认 agent（缺省 Seedream4） */
  imageAgent?: string
  /** 视频默认 agent（缺省 Seedance2Fast） */
  videoAgent?: string
  /** auth.getSession() 进程内缓存秒数（默认 30，0 关闭） */
  authSessionCacheSeconds?: number
  /** 登录模式（默认 app；channel = 用渠道账号登录，不提供注册） */
  authMode?: AuthMode
  /** sqlite 驱动的数据库文件路径（默认 ./data/chatu.sqlite） */
  sqlitePath?: string
}

/** 平台开放的 embedding 模型之一（服务端白名单：text-embedding-3-small / 3-large / ada-002） */
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'

let override: ConfigureOptions = {}
let version = 0

/** 显式配置（测试或非 env 场景）；不调用则完全由环境变量决定 */
export function configure(options: ConfigureOptions): void {
  override = { ...options }
  version += 1
}

/** configure() 调用次数：带内存状态的模块（如 auth 的 memory 驱动）用它判断是否该重建客户端 */
export function configVersion(): number {
  return version
}

/** 读环境变量（不依赖 @types/node，浏览器/边缘运行时下返回 undefined） */
export function readEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

export function resolveConfig(): ResolvedConfig {
  // 不依赖 @types/node：通过 globalThis 读取 process.env
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const env: Record<string, string | undefined> = proc?.env ?? {}
  const baseUrl = override.baseUrl ?? env.CHATU_DATA_URL
  const apiKey = override.apiKey ?? env.CHATU_APP_KEY ?? env.CHATU_CUSTOMER_API_KEY
  const redisUrl = env.REDIS_URL
  const s3Bucket = env.S3_BUCKET
  const envDriver = (env.CHATU_DATA_DRIVER ?? '').toLowerCase()
  const driver: DriverKind =
    override.driver ??
    (envDriver === 'edgeone' || envDriver === 'byo' || envDriver === 'memory' || envDriver === 'platform' || envDriver === 'sqlite'
      ? (envDriver as DriverKind)
      : baseUrl && apiKey ? 'platform' : redisUrl || s3Bucket ? 'byo' : 'memory')
  if (driver === 'sqlite') {
    return {
      kind: 'sqlite',
      path: (override.sqlitePath ?? env.CHATU_SQLITE_PATH ?? '').trim() || DEFAULT_SQLITE_PATH,
      platform: baseUrl && apiKey ? buildPlatformConfig(env, baseUrl, apiKey) : null,
    }
  }
  if (driver === 'edgeone') {
    return {
      kind: 'edgeone',
      kvStore: env.CHATU_EDGEONE_KV_STORE || 'chatu-kv',
      storageStore: env.CHATU_EDGEONE_STORAGE_STORE || 'chatu-storage',
      projectId: env.EDGEONE_BLOB_PROJECT_ID || undefined,
      token: env.EDGEONE_BLOB_TOKEN || undefined,
      publicPathPrefix: (env.CHATU_BLOB_PUBLIC_PATH || '/_chatu/blob').replace(/\/+$/, ''),
    }
  }
  if (driver === 'byo') {
    return {
      kind: 'byo',
      redisUrl,
      kvPrefix: env.CHATU_KV_PREFIX ?? 'app:',
      s3: s3Bucket
        ? {
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION ?? 'us-east-1',
            bucket: s3Bucket,
            accessKey: env.S3_ACCESS_KEY ?? '',
            secretKey: env.S3_SECRET_KEY ?? '',
            prefix: env.S3_PREFIX ?? '',
            forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? '').toLowerCase() === 'true',
          }
        : undefined,
    }
  }
  if (driver === 'platform') {
    if (!baseUrl || !apiKey) throw new Error('@chatu-ai/app-sdk: platform driver requires CHATU_DATA_URL and CHATU_APP_KEY')
    return buildPlatformConfig(env, baseUrl, apiKey)
  }
  return { kind: 'memory' }
}

/** 平台配置（platform 驱动本体；sqlite 等驱动下 auth / storage / ai 也用它继续走平台） */
function buildPlatformConfig(env: Record<string, string | undefined>, baseUrl: string, apiKey: string): PlatformConfig {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  return {
    kind: 'platform',
    baseUrl: normalizedBase,
    apiKey,
    env: (override.env ?? env.CHATU_DATA_ENV ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev',
    fetchImpl: override.fetchImpl ?? fetch,
    aiBaseUrl: (override.aiBaseUrl ?? env.CHATU_AI_URL ?? deriveAiBaseUrl(normalizedBase)).replace(/\/+$/, ''),
    aiModel: override.model ?? env.CHATU_AI_MODEL ?? env.PRIMARY_MODEL,
    aiEmbedModel: override.embedModel ?? env.CHATU_AI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
    aiImageAgent: override.imageAgent ?? env.CHATU_AI_IMAGE_AGENT,
    aiVideoAgent: override.videoAgent ?? env.CHATU_AI_VIDEO_AGENT,
    authSessionCacheSeconds: normalizeCacheSeconds(override.authSessionCacheSeconds ?? env.CHATU_AUTH_SESSION_CACHE),
    authMode: normalizeAuthMode(override.authMode ?? env.CHATU_AUTH_MODE),
  }
}

/** 会话缓存秒数：非法值回落到默认 30，上限 300（避免停用用户长时间仍可用） */
/**
 * 当前登录模式（任何驱动下都可用；memory 驱动也需要它来决定是否走渠道账号替身）。
 */
export function resolveAuthMode(): AuthMode {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return normalizeAuthMode(override.authMode ?? proc?.env?.CHATU_AUTH_MODE)
}

/** 登录模式：只认 channel，其它一律按默认的 app 处理（配错不至于让应用登录不了） */
function normalizeAuthMode(value: string | undefined): AuthMode {
  return String(value ?? '').trim().toLowerCase() === 'channel' ? 'channel' : 'app'
}

function normalizeCacheSeconds(value: number | string | undefined): number {
  if (value === undefined || value === '') return 30
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 30
  return Math.min(Math.floor(n), 300)
}

/** `https://api.chatuapi.com/data/v1` → `https://api.chatuapi.com/v1`（Data API 与 LLM 中继同源） */
export function deriveAiBaseUrl(dataBaseUrl: string): string {
  const trimmed = dataBaseUrl.replace(/\/+$/, '')
  if (/\/data\/v1$/.test(trimmed)) return trimmed.replace(/\/data\/v1$/, '/v1')
  try { return `${new URL(trimmed).origin}/v1` } catch { return `${trimmed}/v1` }
}

/** 当前生效的驱动与环境（诊断用，不含密钥） */
export function describe(): { driver: DriverKind; env?: 'dev' | 'prod'; baseUrl?: string; kv?: string; storage?: string; db?: string; auth?: string } {
  const c = resolveConfig()
  if (c.kind === 'platform') return { driver: 'platform', env: c.env, baseUrl: c.baseUrl }
  if (c.kind === 'sqlite') {
    return { driver: 'sqlite', env: c.platform?.env, baseUrl: c.platform?.baseUrl, db: `sqlite:${c.path}`, kv: `sqlite:${c.path}`, storage: c.platform ? 'platform' : 'memory', auth: c.platform ? 'platform' : 'unsupported' }
  }
  if (c.kind === 'byo') return { driver: 'byo', kv: c.redisUrl ? 'redis' : 'memory', storage: c.s3 ? 's3' : 'memory' }
  if (c.kind === 'edgeone') return { driver: 'edgeone', kv: `blob:${c.kvStore}`, storage: `blob:${c.storageStore}`, db: `blob:${c.kvStore}/db` }
  return { driver: 'memory' }
}

/**
 * AI 中继配置与数据驱动解耦：只要有 CHATU_DATA_URL + CHATU_APP_KEY 就可用（数据走 EdgeOne/byo 时 ai 仍走平台）
 */
export function resolveAiConfig(): PlatformConfig | null {
  const c = resolveConfig()
  if (c.kind === 'platform') return c
  if (c.kind === 'sqlite') return c.platform
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const env: Record<string, string | undefined> = proc?.env ?? {}
  const baseUrl = override.baseUrl ?? env.CHATU_DATA_URL
  const apiKey = override.apiKey ?? env.CHATU_APP_KEY ?? env.CHATU_CUSTOMER_API_KEY
  if (!baseUrl || !apiKey) return null
  return buildPlatformConfig(env, baseUrl, apiKey)
}

/** 动态加载可选依赖（ioredis / @aws-sdk/* / @edgeone/pages-blob），不参与打包静态分析；缺失时给出可操作的错误 */
const registeredModules = new Map<string, unknown>()
/** 测试/打包器场景：预注册可选依赖模块，optionalImport 直接返回（不走动态 import） */
export function registerOptionalModule(name: string, mod: unknown): void {
  registeredModules.set(name, mod)
}

export async function optionalImport<T = any>(name: string, hint: string): Promise<T> {
  if (registeredModules.has(name)) return registeredModules.get(name) as T
  try {
    const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<T>
    return await dyn(name)
  } catch {
    throw new Error(`@chatu-ai/app-sdk: driver requires "${name}" — ${hint}`)
  }
}
