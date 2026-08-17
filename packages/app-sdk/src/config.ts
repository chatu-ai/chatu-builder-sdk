/**
 * 驱动选择（技术方案 15 §1）：
 * - CHATU_DATA_URL + CHATU_APP_KEY（或 CHATU_CUSTOMER_API_KEY）→ platform（平台托管 Data API，开发期/线上都可用，按用量计费）
 * - 都没有 → memory（进程内存，重启即丢；本地开发/无配置降级）
 * 只在服务端使用（Route Handler / Server Component / Server Action）；密钥不得暴露给浏览器。
 */
export type DriverKind = 'platform' | 'memory'

export interface PlatformConfig {
  kind: 'platform'
  baseUrl: string
  apiKey: string
  env: 'dev' | 'prod'
  fetchImpl: typeof fetch
}
export interface MemoryConfig { kind: 'memory' }
export type ResolvedConfig = PlatformConfig | MemoryConfig

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
  const driver = override.driver ?? (baseUrl && apiKey ? 'platform' : 'memory')
  if (driver === 'platform') {
    if (!baseUrl || !apiKey) throw new Error('@chatu-ai/app-sdk: platform driver requires CHATU_DATA_URL and CHATU_APP_KEY')
    const dataEnv = (override.env ?? env.CHATU_DATA_ENV ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev'
    return { kind: 'platform', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, env: dataEnv, fetchImpl: override.fetchImpl ?? fetch }
  }
  return { kind: 'memory' }
}

/** 当前生效的驱动与环境（诊断用，不含密钥） */
export function describe(): { driver: DriverKind; env?: 'dev' | 'prod'; baseUrl?: string } {
  const c = resolveConfig()
  return c.kind === 'platform' ? { driver: 'platform', env: c.env, baseUrl: c.baseUrl } : { driver: 'memory' }
}
