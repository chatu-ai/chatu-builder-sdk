import { resolveConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'
import { byoKv } from './byo.js'
import { edgeoneKv } from './edgeone.js'
import { validateWith, type StandardSchemaV1 } from './schema.js'

export interface KvSetOptions { /** 过期秒数 */ ex?: number }
export interface KvListResult { keys: string[]; nextCursor: string | null }

export interface KvClient {
  get<T = unknown>(key: string): Promise<T | null>
  /**
   * 带 schema 的读取（zod / valibot 等 Standard Schema）：存在则校验并收窄类型，不合格抛 AppSdkError('INVALID_DATA')。
   * 用它替代 `kv.get<T>()` 的裸断言——线上数据结构漂移时能在读取处就暴露，而不是在渲染时炸。
   */
  get<T>(key: string, schema: StandardSchemaV1<unknown, T>): Promise<T | null>
  set(key: string, value: unknown, opts?: KvSetOptions): Promise<void>
  del(key: string): Promise<boolean>
  incr(key: string, by?: number): Promise<number>
  expire(key: string, seconds: number): Promise<boolean>
  mget<T = unknown>(keys: string[]): Promise<Array<T | null>>
  list(prefix?: string, opts?: { cursor?: string | null; limit?: number }): Promise<KvListResult>
}

// ---------- platform driver ----------
function platformKv(cfg: PlatformConfig): KvClient {
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
function memoryKv(): KvClient {
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
  const key = cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}` : cfg.kind === 'byo' ? `byo|${cfg.redisUrl ?? ''}|${cfg.kvPrefix}` : cfg.kind === 'edgeone' ? `edgeone|${cfg.kvStore}|${cfg.projectId ?? ''}` : 'memory'
  if (!cached || cached.key !== key) cached = { key, client: withSchema(cfg.kind === 'platform' ? platformKv(cfg) : cfg.kind === 'byo' ? byoKv(cfg, memoryKv()) : cfg.kind === 'edgeone' ? edgeoneKv(cfg) : memoryKv()) }
  return cached.client
}

/** 给任意驱动补上 `get(key, schema)`：驱动只实现裸 get，校验统一在这一层做 */
function withSchema(inner: KvClient): KvClient {
  return {
    ...inner,
    async get(key: string, schema?: StandardSchemaV1<unknown, any>) {
      const value = await inner.get(key)
      if (value === null || !schema) return value
      return validateWith(schema, value, 'INVALID_DATA', `kv "${key}"`)
    },
  }
}

/** 便捷单例：`import { kv } from '@chatu-ai/app-sdk'` */
export const kv: KvClient = {
  get: (k: string, s?: StandardSchemaV1<unknown, any>) => (s ? getKv().get(k, s) : getKv().get(k)),
  set: (k, v, o) => getKv().set(k, v, o),
  del: (k) => getKv().del(k),
  incr: (k, b) => getKv().incr(k, b),
  expire: (k, s) => getKv().expire(k, s),
  mget: (ks) => getKv().mget(ks),
  list: (p, o) => getKv().list(p, o),
}
