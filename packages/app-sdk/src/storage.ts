import { resolveConfig, type PlatformConfig } from './config.js'
import { edgeoneStorage } from './edgeone.js'
import { AppSdkError } from './errors.js'
import { byoStorage } from './byo.js'

export interface StorageObject { key: string; size: number; lastModified?: string | null }
export interface StorageListResult { items: StorageObject[]; nextCursor: string | null }
export interface UploadUrlResult { url: string; method: 'PUT'; expiresIn: number; headers?: Record<string, string> }

export interface StorageClient {
  /** 服务端小文件直传（≤5MB） */
  put(key: string, data: Uint8Array | ArrayBuffer | string | Blob, opts?: { contentType?: string }): Promise<{ key: string; size: number }>
  /** 浏览器直传：返回预签名 PUT 地址（把它交给前端 fetch(url, { method:'PUT', body:file })） */
  uploadUrl(key: string, opts?: { contentType?: string; size?: number }): Promise<UploadUrlResult>
  /** 读取对象内容（服务端） */
  get(key: string): Promise<Uint8Array | null>
  /** 临时访问地址（默认 10 分钟；可指定秒数、下载文件名）—— 用于 <img src> / 下载链接 */
  url(key: string, opts?: { expiresIn?: number; downloadName?: string }): Promise<string>
  head(key: string): Promise<StorageObject | null>
  delete(key: string): Promise<void>
  list(prefix?: string, opts?: { cursor?: string | null; limit?: number }): Promise<StorageListResult>
}

function toBytes(data: Uint8Array | ArrayBuffer | string | Blob): Promise<Uint8Array> {
  if (typeof data === 'string') return Promise.resolve(new TextEncoder().encode(data))
  if (data instanceof Uint8Array) return Promise.resolve(data)
  if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data))
  return data.arrayBuffer().then(b => new Uint8Array(b))
}

// ---------- platform driver ----------
function platformStorage(cfg: PlatformConfig): StorageClient {
  const base = { 'x-api-key': cfg.apiKey, 'x-chatu-env': cfg.env }
  const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/')
  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}/storage${path}`, { method, headers: { ...base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let j: any = null
    try { j = await res.json() } catch { /* ignore */ }
    if (!res.ok || j?.ok === false) throw new AppSdkError(j?.error ?? `HTTP_${res.status}`, j?.message ?? `storage ${method} ${path} failed (${res.status})`, res.status)
    return j as T
  }
  return {
    async put(key, data, opts) {
      const bytes = await toBytes(data)
      const res = await cfg.fetchImpl(`${cfg.baseUrl}/storage/${enc(key)}`, { method: 'PUT', headers: { ...base, 'content-type': opts?.contentType ?? 'application/octet-stream' }, body: bytes as unknown as BodyInit })
      let j: any = null
      try { j = await res.json() } catch { /* ignore */ }
      if (!res.ok || j?.ok === false) throw new AppSdkError(j?.error ?? `HTTP_${res.status}`, j?.message ?? `storage put failed (${res.status})`, res.status)
      return { key, size: j.size ?? bytes.byteLength }
    },
    async uploadUrl(key, opts) {
      const r = await json<{ url: string; expiresIn: number; headers?: { contentType?: string } }>('POST', '/upload-url', { key, contentType: opts?.contentType, size: opts?.size })
      return { url: r.url, method: 'PUT', expiresIn: r.expiresIn, headers: r.headers?.contentType ? { 'content-type': r.headers.contentType } : undefined }
    },
    async get(key) {
      const r = await json<{ url: string }>('POST', '/sign', { key })
      const res = await cfg.fetchImpl(r.url)
      if (res.status === 404) return null
      if (!res.ok) throw new AppSdkError(`HTTP_${res.status}`, `storage get failed (${res.status})`, res.status)
      return new Uint8Array(await res.arrayBuffer())
    },
    async url(key, opts) {
      const r = await json<{ url: string }>('POST', '/sign', { key, expiresIn: opts?.expiresIn, downloadName: opts?.downloadName })
      return r.url
    },
    async head(key) {
      const res = await cfg.fetchImpl(`${cfg.baseUrl}/storage/${enc(key)}?meta=1`, { headers: base })
      if (res.status === 404) return null
      const j: any = await res.json().catch(() => null)
      if (!res.ok || j?.ok === false) throw new AppSdkError(j?.error ?? `HTTP_${res.status}`, j?.message ?? 'storage head failed', res.status)
      return { key, size: j.size, lastModified: j.lastModified ?? null }
    },
    async delete(key) { await json('DELETE', `/${enc(key)}`) },
    async list(prefix = '', opts) {
      const q = new URLSearchParams({ prefix, limit: String(opts?.limit ?? 100) })
      if (opts?.cursor) q.set('cursor', opts.cursor)
      const r = await json<{ items: StorageObject[]; nextCursor: string | null }>('GET', `?${q.toString()}`)
      return { items: r.items, nextCursor: r.nextCursor ?? null }
    },
  }
}

// ---------- memory driver ----------
function memoryStorage(): StorageClient {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string; at: string }>()
  return {
    async put(key, data, opts) { const bytes = await toBytes(data); store.set(key, { bytes, contentType: opts?.contentType, at: new Date().toISOString() }); return { key, size: bytes.byteLength } },
    async uploadUrl(key) { return { url: `memory://${key}`, method: 'PUT', expiresIn: 0 } },
    async get(key) { return store.get(key)?.bytes ?? null },
    async url(key) { const e = store.get(key); if (!e) return `memory://${key}`; const b64 = btoa(String.fromCharCode(...e.bytes)); return `data:${e.contentType ?? 'application/octet-stream'};base64,${b64}` },
    async head(key) { const e = store.get(key); return e ? { key, size: e.bytes.byteLength, lastModified: e.at } : null },
    async delete(key) { store.delete(key) },
    async list(prefix = '', opts) {
      const all = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      const start = opts?.cursor ? Number(opts.cursor) : 0
      const limit = opts?.limit ?? 100
      const page = all.slice(start, start + limit).map(([key, e]) => ({ key, size: e.bytes.byteLength, lastModified: e.at }))
      return { items: page, nextCursor: start + limit < all.length ? String(start + limit) : null }
    },
  }
}

let cached: { key: string; client: StorageClient } | null = null

export function getStorage(): StorageClient {
  const cfg = resolveConfig()
  const key = cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}` : cfg.kind === 'byo' ? `byo|${cfg.s3?.bucket ?? ''}|${cfg.s3?.prefix ?? ''}` : cfg.kind === 'edgeone' ? `edgeone|${cfg.storageStore}|${cfg.projectId ?? ''}` : 'memory'
  if (!cached || cached.key !== key) cached = { key, client: cfg.kind === 'platform' ? platformStorage(cfg) : cfg.kind === 'byo' ? byoStorage(cfg, memoryStorage()) : cfg.kind === 'edgeone' ? edgeoneStorage(cfg) : memoryStorage() }
  return cached.client
}

export const storage: StorageClient = {
  put: (k, d, o) => getStorage().put(k, d, o),
  uploadUrl: (k, o) => getStorage().uploadUrl(k, o),
  get: (k) => getStorage().get(k),
  url: (k, o) => getStorage().url(k, o),
  head: (k) => getStorage().head(k),
  delete: (k) => getStorage().delete(k),
  list: (p, o) => getStorage().list(p, o),
}
