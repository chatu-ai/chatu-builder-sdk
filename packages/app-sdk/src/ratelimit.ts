import { getKv } from './kv.js'

export interface RatelimitOptions {
  /** 窗口内允许的最大次数 */
  limit: number
  /** 窗口长度（秒） */
  window: number
  /** 键前缀（默认 `rl`），多个限流器共用一个 key 时用它区分 */
  prefix?: string
}
export interface RatelimitResult {
  /** 是否放行 */
  ok: boolean
  /** 本窗口剩余次数（拒绝时为 0） */
  remaining: number
  /** 距本窗口重置的秒数（拒绝时可直接放进 Retry-After） */
  reset: number
  /** 本窗口已计数（含本次） */
  count: number
}

/**
 * 固定窗口限流，基于 kv.incr + expire：AI 接口防刷、验证码/表单提交限频、每用户每日额度都用它。
 * key 建议带上主体（用户 id / IP / 路由），如 `ai:${userId}`。
 * 窗口按 `floor(now / window)` 分桶，桶键自然隔离，不依赖 expire 是否成功；expire 只是用来回收旧桶。
 */
export async function ratelimit(key: string, opts: RatelimitOptions): Promise<RatelimitResult> {
  const limit = Math.max(1, Math.floor(opts.limit))
  const window = Math.max(1, Math.floor(opts.window))
  const nowSec = Math.floor(Date.now() / 1000)
  const bucket = Math.floor(nowSec / window)
  const reset = (bucket + 1) * window - nowSec
  const kv = getKv()
  const bucketKey = `${opts.prefix ?? 'rl'}:${key}:${bucket}`
  const count = await kv.incr(bucketKey)
  if (count === 1) {
    // 首次创建桶时挂过期（多给一个窗口的余量，避免边界上刚创建就被回收）
    try { await kv.expire(bucketKey, window * 2) } catch { /* 过期失败不影响判定，旧桶只是晚点回收 */ }
  }
  return { ok: count <= limit, remaining: Math.max(0, limit - count), reset, count }
}
