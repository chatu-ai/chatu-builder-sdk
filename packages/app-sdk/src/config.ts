/**
 * 驱动选择（技术方案 15 §1）：
 * - CHATU_DATA_URL + CHATU_APP_KEY（或 CHATU_CUSTOMER_API_KEY）→ platform（平台托管 Data API，开发期/线上都可用，按用量计费）
 * - 都没有 → memory（进程内存，重启即丢；本地开发/无配置降级）
 * 只在服务端使用（Route Handler / Server Component / Server Action）；密钥不得暴露给浏览器。
 */
export type DriverKind = 'platform' | 'byo' | 'memory'

export interface PlatformConfig {
  kind: 'platform'
  baseUrl: string
  apiKey: string
  env: 'dev' | 'prod'
  fetchImpl: typeof fetch
}
export interface MemoryConfig { kind: 'memory' }
/** 自带云资源（模式 A）：REDIS_URL → KV；S3_* → 对象存储（腾讯云 COS / MinIO / AWS 等 S3 兼容） */
export interface ByoConfig {
  kind: 'byo'
  redisUrl?: string
  kvPrefix: string
  s3?: { endpoint?: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string; forcePathStyle: boolean }
}
export type ResolvedConfig = PlatformConfig | ByoConfig | MemoryConfig

export interface ConfigureOptions {
  baseUrl?: string
  apiKey?: string
  env?: 'dev' | 'prod'
  driver?: DriverKind
  fetchImpl?: typeof fetch
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
  const driver = override.driver ?? (baseUrl && apiKey ? 'platform' : redisUrl || s3Bucket ? 'byo' : 'memory')
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
    return { kind: 'platform', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, env: dataEnv, fetchImpl: override.fetchImpl ?? fetch }
  }
  return { kind: 'memory' }
}

/** 当前生效的驱动与环境（诊断用，不含密钥） */
export function describe(): { driver: DriverKind; env?: 'dev' | 'prod'; baseUrl?: string; kv?: string; storage?: string } {
  const c = resolveConfig()
  if (c.kind === 'platform') return { driver: 'platform', env: c.env, baseUrl: c.baseUrl }
  if (c.kind === 'byo') return { driver: 'byo', kv: c.redisUrl ? 'redis' : 'memory', storage: c.s3 ? 's3' : 'memory' }
  return { driver: 'memory' }
}

/** 动态加载可选依赖（ioredis / @aws-sdk/*），不参与打包静态分析；缺失时给出可操作的错误 */
export async function optionalImport<T = any>(name: string, hint: string): Promise<T> {
  try {
    const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<T>
    return await dyn(name)
  } catch {
    throw new Error(`@chatu-ai/app-sdk: byo driver requires "${name}" — ${hint}`)
  }
}
