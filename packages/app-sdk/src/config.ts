/**
 * 驱动选择（技术方案 15 §1）：
 * - CHATU_DATA_URL + CHATU_APP_KEY（或 CHATU_CUSTOMER_API_KEY）→ platform（平台托管 Data API，开发期/线上都可用，按用量计费）
 * - 都没有 → memory（进程内存，重启即丢；本地开发/无配置降级）
 * 只在服务端使用（Route Handler / Server Component / Server Action）；密钥不得暴露给浏览器。
 */
export type DriverKind = 'platform' | 'byo' | 'memory' | 'edgeone'

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
export type ResolvedConfig = PlatformConfig | ByoConfig | MemoryConfig | EdgeoneConfig

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
}

let override: ConfigureOptions = {}

/** 显式配置（测试或非 env 场景）；不调用则完全由环境变量决定 */
export function configure(options: ConfigureOptions): void {
  override = { ...options }
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
    (envDriver === 'edgeone' || envDriver === 'byo' || envDriver === 'memory' || envDriver === 'platform'
      ? (envDriver as DriverKind)
      : baseUrl && apiKey ? 'platform' : redisUrl || s3Bucket ? 'byo' : 'memory')
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
    const dataEnv = (override.env ?? env.CHATU_DATA_ENV ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev'
    const normalizedBase = baseUrl.replace(/\/+$/, '')
    return {
      kind: 'platform',
      baseUrl: normalizedBase,
      apiKey,
      env: dataEnv,
      fetchImpl: override.fetchImpl ?? fetch,
      aiBaseUrl: (override.aiBaseUrl ?? env.CHATU_AI_URL ?? deriveAiBaseUrl(normalizedBase)).replace(/\/+$/, ''),
      aiModel: override.model ?? env.CHATU_AI_MODEL ?? env.PRIMARY_MODEL,
    }
  }
  return { kind: 'memory' }
}

/** `https://api.chatuapi.com/data/v1` → `https://api.chatuapi.com/v1`（Data API 与 LLM 中继同源） */
export function deriveAiBaseUrl(dataBaseUrl: string): string {
  const trimmed = dataBaseUrl.replace(/\/+$/, '')
  if (/\/data\/v1$/.test(trimmed)) return trimmed.replace(/\/data\/v1$/, '/v1')
  try { return `${new URL(trimmed).origin}/v1` } catch { return `${trimmed}/v1` }
}

/** 当前生效的驱动与环境（诊断用，不含密钥） */
export function describe(): { driver: DriverKind; env?: 'dev' | 'prod'; baseUrl?: string; kv?: string; storage?: string } {
  const c = resolveConfig()
  if (c.kind === 'platform') return { driver: 'platform', env: c.env, baseUrl: c.baseUrl }
  if (c.kind === 'byo') return { driver: 'byo', kv: c.redisUrl ? 'redis' : 'memory', storage: c.s3 ? 's3' : 'memory' }
  if (c.kind === 'edgeone') return { driver: 'edgeone', kv: `blob:${c.kvStore}`, storage: `blob:${c.storageStore}` }
  return { driver: 'memory' }
}

/**
 * AI 中继配置与数据驱动解耦：只要有 CHATU_DATA_URL + CHATU_APP_KEY 就可用（数据走 EdgeOne/byo 时 ai 仍走平台）
 */
export function resolveAiConfig(): PlatformConfig | null {
  const c = resolveConfig()
  if (c.kind === 'platform') return c
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const env: Record<string, string | undefined> = proc?.env ?? {}
  const baseUrl = override.baseUrl ?? env.CHATU_DATA_URL
  const apiKey = override.apiKey ?? env.CHATU_APP_KEY ?? env.CHATU_CUSTOMER_API_KEY
  if (!baseUrl || !apiKey) return null
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  return {
    kind: 'platform',
    baseUrl: normalizedBase,
    apiKey,
    env: (override.env ?? env.CHATU_DATA_ENV ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev',
    fetchImpl: override.fetchImpl ?? fetch,
    aiBaseUrl: (override.aiBaseUrl ?? env.CHATU_AI_URL ?? deriveAiBaseUrl(normalizedBase)).replace(/\/+$/, ''),
    aiModel: override.model ?? env.CHATU_AI_MODEL ?? env.PRIMARY_MODEL,
  }
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
