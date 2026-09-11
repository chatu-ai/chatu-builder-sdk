import { configVersion, resolveConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'
import { byoKv } from './byo.js'
import { edgeoneKv } from './edgeone.js'
import { sqliteKv } from './sqlite.js'
import { validateWith, type StandardSchemaV1 } from './schema.js'

export interface KvSetOptions { /** 过期秒数 */ ex?: number }
export interface KvListResult { keys: string[]; nextCursor: string | null }

/** kv.lock() 拿到的锁句柄；用完必须 release（放在 finally 里） */
export interface KvLock {
  /** 被锁住的业务键 */
  key: string
  /** 释放锁；只删自己持有的那把（token 比对），不会误删超时后别人拿到的锁 */
  release(): Promise<void>
}
export interface KvLockOptions {
  /** 锁的存活时间（毫秒，默认 10000）：持有者崩溃也会到点自动释放，别设得比临界区还短 */
  ttlMs?: number
  /** 拿不到锁时最多等多久（毫秒，默认 0 = 不等，立刻返回 null） */
  waitMs?: number
}

export interface KvClient {
  get<T = unknown>(key: string): Promise<T | null>
  /**
   * 带 schema 的读取（zod / valibot 等 Standard Schema）：存在则校验并收窄类型，不合格抛 AppSdkError('INVALID_DATA')。
   * 用它替代 `kv.get<T>()` 的裸断言——线上数据结构漂移时能在读取处就暴露，而不是在渲染时炸。
   */
  get<T>(key: string, schema: StandardSchemaV1<unknown, T>): Promise<T | null>
  set(key: string, value: unknown, opts?: KvSetOptions): Promise<void>
  /**
   * 只在键不存在时写入，返回是否真的写进去了（技术方案 34 §2）。
   * 用于幂等（同一次提交只处理一次）、唯一占位、以及 lock() 的底座。edgeone 驱动下是 best-effort（Blob 没有原子写）。
   */
  setnx(key: string, value: unknown, opts?: KvSetOptions): Promise<boolean>
  /**
   * 互斥锁（基于 setnx）：拿到返回句柄，没拿到返回 null。
   * ```ts
   * const lock = await kv.lock('seat:' + id, { waitMs: 2000 })
   * if (!lock) return { error: '请稍后重试' }
   * try { /* 读-改-写 *\/ } finally { await lock.release() }
   * ```
   */
  lock(key: string, opts?: KvLockOptions): Promise<KvLock | null>
  del(key: string): Promise<boolean>
  incr(key: string, by?: number): Promise<number>
  expire(key: string, seconds: number): Promise<boolean>
  mget<T = unknown>(keys: string[]): Promise<Array<T | null>>
  list(prefix?: string, opts?: { cursor?: string | null; limit?: number }): Promise<KvListResult>
}

/** 驱动只实现 setnx 等原子原语，lock 由 withSchema 统一在上层实现 */
export type KvDriver = Omit<KvClient, 'lock'>

// ---------- platform driver ----------
function platformKv(cfg: PlatformConfig): KvDriver {
  const headers = { 'x-api-key': cfg.apiKey, 'x-chatu-env': cfg.env, 'content-type': 'application/json' }
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}/kv${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let json: any = null
    try { json = await res.json() } catch { /* ignore */ }
    if (!res.ok || json?.ok === false) {
      throw new AppSdkError(json?.error ?? `HTTP_${res.status}`, json?.message ?? `kv ${method} ${path} failed (${res.status})`, res.status)
    }
    return json as T
  }
  const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/')
  return {
    async get(key) { const r = await call<{ exists: boolean; value: unknown }>('GET', `/${enc(key)}`); return r.exists ? (r.value as any) : null },
    async set(key, value, opts) { await call('PUT', `/${enc(key)}`, { value, ex: opts?.ex }) },
    async setnx(key, value, opts) {
      const r = await call<{ stored?: boolean }>('PUT', `/${enc(key)}`, { value, ex: opts?.ex, nx: true })
      // 平台早于 2026-09-11 的版本不认 nx，会当普通 set 处理且不返回 stored——宁可报错也不能谎报"抢到了"
      if (typeof r.stored !== 'boolean') throw new AppSdkError('SETNX_UNSUPPORTED', 'platform data service is too old for kv.setnx/lock')
      return r.stored
    },
    async del(key) { const r = await call<{ removed: boolean }>('DELETE', `/${enc(key)}`); return r.removed },
    async incr(key, by = 1) { const r = await call<{ value: number }>('POST', '/incr', { key, by }); return r.value },
    async expire(key, seconds) { const r = await call<{ applied: boolean }>('POST', '/expire', { key, seconds }); return r.applied },
    async mget(keys) { const r = await call<{ items: Array<{ key: string; value: unknown; exists: boolean }> }>('POST', '/mget', { keys }); return r.items.map(i => (i.exists ? (i.value as any) : null)) },
    async list(prefix = '', opts) {
      const q = new URLSearchParams({ prefix, limit: String(opts?.limit ?? 100) })
      if (opts?.cursor) q.set('cursor', opts.cursor)
      const r = await call<{ keys: string[]; nextCursor: string | null }>('GET', `?${q.toString()}`)
      return { keys: r.keys, nextCursor: r.nextCursor ?? null }
    },
  }
}

// ---------- memory driver ----------
function memoryKv(): KvDriver {
  const store = new Map<string, { value: unknown; expiresAt?: number }>()
  const live = (key: string) => {
    const e = store.get(key)
    if (!e) return null
    if (e.expiresAt !== undefined && Date.now() > e.expiresAt) { store.delete(key); return null }
    return e
  }
  return {
    async get(key) { return (live(key)?.value as any) ?? null },
    async set(key, value, opts) { store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined }) },
    async setnx(key, value, opts) {
      if (live(key)) return false
      store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined })
      return true
    },
    async del(key) { return store.delete(key) },
    async incr(key, by = 1) { const e = live(key); const cur = Number(e?.value ?? 0); if (!Number.isInteger(cur)) throw new AppSdkError('NOT_AN_INTEGER', 'value is not an integer'); const next = cur + by; store.set(key, { value: next, expiresAt: e?.expiresAt }); return next },
    async expire(key, seconds) { const e = live(key); if (!e) return false; e.expiresAt = Date.now() + seconds * 1000; return true },
    async mget(keys) { return keys.map(k => (live(k)?.value as any) ?? null) },
    async list(prefix = '', opts) {
      const all = [...store.keys()].filter(k => k.startsWith(prefix) && live(k)).sort()
      const start = opts?.cursor ? Number(opts.cursor) : 0
      const limit = opts?.limit ?? 100
      const page = all.slice(start, start + limit)
      return { keys: page, nextCursor: start + limit < all.length ? String(start + limit) : null }
    },
  }
}

let cached: { key: string; client: KvClient } | null = null

/** 按当前配置取 KV 客户端（惰性、缓存；configure() 后自动重建） */
export function getKv(): KvClient {
  const cfg = resolveConfig()
  // 并入 configure() 次数：换 fetchImpl / 换配置时重建，不会拿到上一份闭包
  const key = `${configVersion()}|` + (cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}` : cfg.kind === 'byo' ? `byo|${cfg.redisUrl ?? ''}|${cfg.kvPrefix}` : cfg.kind === 'edgeone' ? `edgeone|${cfg.kvStore}|${cfg.projectId ?? ''}` : cfg.kind === 'sqlite' ? `sqlite|${cfg.path}` : 'memory')
  if (!cached || cached.key !== key) cached = { key, client: withSchema(cfg.kind === 'platform' ? platformKv(cfg) : cfg.kind === 'byo' ? byoKv(cfg, memoryKv()) : cfg.kind === 'edgeone' ? edgeoneKv(cfg) : cfg.kind === 'sqlite' ? sqliteKv(cfg) : memoryKv()) }
  return cached.client
}

/**
 * 给任意驱动补上两件公共能力：
 * - `get(key, schema)`：驱动只实现裸 get，校验统一在这一层做
 * - `lock(key)`：基于驱动的 setnx + 随机 token，所有驱动共用一份实现（技术方案 34 §2）
 */
function withSchema(inner: KvDriver): KvClient {
  return {
    ...inner,
    async get(key: string, schema?: StandardSchemaV1<unknown, any>) {
      const value = await inner.get(key)
      if (value === null || !schema) return value
      return validateWith(schema, value, 'INVALID_DATA', `kv "${key}"`)
    },
    async lock(key: string, opts?: KvLockOptions) {
      const ttlMs = Math.max(1000, opts?.ttlMs ?? 10_000)
      const deadline = Date.now() + Math.max(0, opts?.waitMs ?? 0)
      const lockKey = `__lock:${key}`
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
      for (;;) {
        if (await inner.setnx(lockKey, token, { ex: Math.ceil(ttlMs / 1000) })) {
          return {
            key,
            async release() {
              // 只删自己那把：锁已超时被别人拿走时不动它
              if ((await inner.get(lockKey)) === token) await inner.del(lockKey)
            },
          }
        }
        if (Date.now() >= deadline) return null
        await new Promise(r => setTimeout(r, 50))
      }
    },
  }
}

/** 便捷单例：`import { kv } from '@chatu-ai/app-sdk'` */
export const kv: KvClient = {
  get: (k: string, s?: StandardSchemaV1<unknown, any>) => (s ? getKv().get(k, s) : getKv().get(k)),
  set: (k, v, o) => getKv().set(k, v, o),
  setnx: (k, v, o) => getKv().setnx(k, v, o),
  lock: (k, o) => getKv().lock(k, o),
  del: (k) => getKv().del(k),
  incr: (k, b) => getKv().incr(k, b),
  expire: (k, s) => getKv().expire(k, s),
  mget: (ks) => getKv().mget(ks),
  list: (p, o) => getKv().list(p, o),
}
