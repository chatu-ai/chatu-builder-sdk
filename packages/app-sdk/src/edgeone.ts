import type { EdgeoneConfig } from './config.js'
import { optionalImport } from './config.js'
import { AppSdkError } from './errors.js'
import type { KvClient } from './kv.js'
import type { StorageClient, StorageObject } from './storage.js'
import { applyUpdate, newDocId, queryDocs, withMeta, type Collection, type DbClient, type Doc } from './db.js'

/**
 * EdgeOne Pages Blob 驱动（部署到 EdgeOne Pages 时使用；kv 与 storage 都落在 Pages Blob）
 * - 依赖 `@edgeone/pages-blob`（Pages 函数内免凭据；外部访问需 projectId + token）
 * - kv：一个 store（默认 chatu-kv），值为 JSON 信封 `{ v, exp? }`，TTL 由信封模拟；读取用 strong 一致性保证读己之写；
 *   incr/expire 为读-改-写（非原子），适合计数展示类场景，不适合并发抢占
 * - storage：一个 store（默认 chatu-storage）；uploadUrl 用 createUploadUrl 预签名 PUT；
 *   Blob 无公开读地址 → url() 返回应用内代理路由 `${publicPathPrefix}/<key>`（模板内置 /_chatu/blob 路由，经 storage.get 回源）
 */

type Store = {
  set(key: string, value: any, opts?: { onlyIfNew?: boolean; cacheControl?: string | null }): Promise<void>
  setJSON(key: string, value: unknown, opts?: { onlyIfNew?: boolean }): Promise<void>
  get(key: string, opts?: { type?: string; consistency?: 'eventual' | 'strong' }): Promise<any>
  getMetadata(key: string, opts?: { consistency?: 'eventual' | 'strong' }): Promise<{ contentType?: string; etag?: string; headers?: Record<string, string> } | null>
  delete(key: string): Promise<void>
  list(opts?: { prefix?: string; cursor?: string; limit?: number; paginate?: boolean; directories?: boolean; consistency?: 'eventual' | 'strong' }): Promise<{ blobs: Array<{ key: string; etag: string }>; directories?: string[]; cursor?: string }>
  createUploadUrl(key: string, opts?: { expireSeconds?: number; contentType?: string }): Promise<{ url: string; key: string; expiresAt: number }>
}

const HINT = 'run `npm i @edgeone/pages-blob` (preinstalled in the ChatU Builder template)'

function storeFactory(cfg: EdgeoneConfig): (name: string) => Promise<Store> {
  let modPromise: Promise<any> | null = null
  const cache = new Map<string, Promise<Store>>()
  return (name: string) => {
    let p = cache.get(name)
    if (!p) {
      p = (modPromise ??= optionalImport<any>('@edgeone/pages-blob', HINT)).then(m => {
        const getStore = m.getStore ?? m.default?.getStore
        if (typeof getStore !== 'function') throw new AppSdkError('EDGEONE_SDK', '@edgeone/pages-blob: getStore not found')
        return cfg.projectId && cfg.token
          ? (getStore({ name, projectId: cfg.projectId, token: cfg.token, consistency: 'strong' }) as Store)
          : (getStore(name) as Store)
      })
      cache.set(name, p)
    }
    return p
  }
}

/** kv 键 → Blob key：逐字符编码保持前缀关系（list(prefix) 可用），'/' 保留为目录分隔 */
export function encodeKvKey(key: string): string {
  return key
    .split('/')
    .map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}
export function decodeKvKey(key: string): string {
  try { return key.split('/').map(decodeURIComponent).join('/') } catch { return key }
}

interface Envelope { v: unknown; exp?: number }

function wrapErr(e: any, what: string): AppSdkError {
  if (e instanceof AppSdkError) return e
  const code = typeof e?.code === 'string' ? e.code : 'EDGEONE_BLOB'
  return new AppSdkError(code, `${what}: ${e?.message ?? String(e)}`)
}

export function edgeoneKv(cfg: EdgeoneConfig): KvClient {
  const getStore = storeFactory(cfg)
  const store = () => getStore(cfg.kvStore)
  const readEnv = async (key: string): Promise<Envelope | null> => {
    const s = await store()
    let raw: any
    try { raw = await s.get(encodeKvKey(key), { type: 'json', consistency: 'strong' }) } catch (e) { throw wrapErr(e, 'kv get') }
    if (raw === null || raw === undefined) return null
    const env: Envelope = raw && typeof raw === 'object' && 'v' in raw ? raw : { v: raw }
    if (env.exp !== undefined && Date.now() > env.exp) {
      void s.delete(encodeKvKey(key)).catch(() => undefined)
      return null
    }
    return env
  }
  const writeEnv = async (key: string, env: Envelope) => {
    const s = await store()
    try { await s.setJSON(encodeKvKey(key), env) } catch (e) { throw wrapErr(e, 'kv set') }
  }
  return {
    async get(key) { return ((await readEnv(key))?.v as any) ?? null },
    async set(key, value, opts) { await writeEnv(key, { v: value, exp: opts?.ex ? Date.now() + opts.ex * 1000 : undefined }) },
    async del(key) {
      const s = await store()
      const existed = (await readEnv(key)) !== null
      try { await s.delete(encodeKvKey(key)) } catch (e) { throw wrapErr(e, 'kv del') }
      return existed
    },
    async incr(key, by = 1) {
      const env = await readEnv(key)
      const cur = Number(env?.v ?? 0)
      if (!Number.isInteger(cur)) throw new AppSdkError('NOT_AN_INTEGER', 'value is not an integer')
      const next = cur + by
      await writeEnv(key, { v: next, exp: env?.exp })
      return next
    },
    async expire(key, seconds) {
      const env = await readEnv(key)
      if (!env) return false
      await writeEnv(key, { v: env.v, exp: Date.now() + seconds * 1000 })
      return true
    },
    async mget(keys) { return Promise.all(keys.map(async k => ((await readEnv(k))?.v as any) ?? null)) },
    async list(prefix = '', opts) {
      const s = await store()
      let r: { blobs: Array<{ key: string }>; cursor?: string }
      try {
        r = await s.list({ prefix: encodeKvKey(prefix), cursor: opts?.cursor ?? undefined, limit: opts?.limit ?? 100, paginate: false, consistency: 'strong' })
      } catch (e) { throw wrapErr(e, 'kv list') }
      return { keys: r.blobs.map(b => decodeKvKey(b.key)), nextCursor: r.cursor ?? null }
    },
  }
}

export function edgeoneStorage(cfg: EdgeoneConfig): StorageClient {
  const getStore = storeFactory(cfg)
  const store = () => getStore(cfg.storageStore)
  const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/')
  const toBlob = async (data: Uint8Array | ArrayBuffer | string | Blob, contentType?: string): Promise<Blob> => {
    if (data instanceof Blob) return contentType && data.type !== contentType ? new Blob([await data.arrayBuffer()], { type: contentType }) : data
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
    return new Blob([bytes as any], { type: contentType ?? 'application/octet-stream' })
  }
  const head = async (key: string): Promise<StorageObject | null> => {
    const s = await store()
    let m: Awaited<ReturnType<Store['getMetadata']>>
    try { m = await s.getMetadata(key, { consistency: 'strong' }) } catch (e) { throw wrapErr(e, 'storage head') }
    if (!m) return null
    const len = Number(m.headers?.['content-length'] ?? m.headers?.['Content-Length'] ?? 0)
    const lm = m.headers?.['last-modified'] ?? m.headers?.['Last-Modified'] ?? null
    return { key, size: Number.isFinite(len) ? len : 0, lastModified: lm }
  }
  return {
    async put(key, data, opts) {
      const s = await store()
      const blob = await toBlob(data, opts?.contentType)
      try { await s.set(key, blob) } catch (e) { throw wrapErr(e, 'storage put') }
      return { key, size: blob.size }
    },
    async uploadUrl(key, opts) {
      const s = await store()
      const expireSeconds = 600
      let r: { url: string; expiresAt: number }
      try { r = await s.createUploadUrl(key, { expireSeconds, contentType: opts?.contentType }) } catch (e) { throw wrapErr(e, 'storage uploadUrl') }
      return { url: r.url, method: 'PUT', expiresIn: expireSeconds, headers: opts?.contentType ? { 'content-type': opts.contentType } : undefined }
    },
    async get(key) {
      const s = await store()
      let buf: ArrayBuffer | null
      try { buf = await s.get(key, { type: 'arrayBuffer', consistency: 'strong' }) } catch (e) { throw wrapErr(e, 'storage get') }
      return buf ? new Uint8Array(buf) : null
    },
    async url(key, opts) {
      // Pages Blob 无公开读地址：走应用内代理路由（模板内置），下载名通过 query 传给路由
      const q = opts?.downloadName ? `?download=${encodeURIComponent(opts.downloadName)}` : ''
      return `${cfg.publicPathPrefix}/${enc(key)}${q}`
    },
    head,
    async delete(key) {
      const s = await store()
      try { await s.delete(key) } catch (e) { throw wrapErr(e, 'storage delete') }
    },
    async list(prefix = '', opts) {
      const s = await store()
      let r: { blobs: Array<{ key: string; etag: string }>; cursor?: string }
      try {
        r = await s.list({ prefix, cursor: opts?.cursor ?? undefined, limit: opts?.limit ?? 100, paginate: false, consistency: 'strong' })
      } catch (e) { throw wrapErr(e, 'storage list') }
      return { items: r.blobs.map(b => ({ key: b.key, size: 0, lastModified: null })), nextCursor: r.cursor ?? null }
    },
  }
}

/**
 * EdgeOne Pages Blob 上的文档集合：`db/{coll}/{id}` 一个对象一个文档，
 * 查询用 list(prefix) 拉全量后在内存过滤/排序/分页（与平台驱动同语义，适合万级以内）。
 */
export function edgeoneDb(cfg: EdgeoneConfig): DbClient {
  const getStore = storeFactory(cfg)
  const store = () => getStore(cfg.kvStore)
  const docKey = (coll: string, id: string) => `db/${coll}/${id}`

  async function all<T>(coll: string): Promise<Doc<T>[]> {
    const s = await store()
    let listed: { blobs: Array<{ key: string }> }
    try {
      listed = await s.list({ prefix: `db/${coll}/`, paginate: true, consistency: 'strong' })
    } catch (e) { throw wrapErr(e, 'db list') }
    const docs: Array<Doc<T> | null> = await Promise.all(
      listed.blobs.map(async b => {
        try { return ((await s.get(b.key, { type: 'json', consistency: 'strong' })) as Doc<T> | null) ?? null } catch { return null }
      }),
    )
    return docs.filter((d): d is Doc<T> => d !== null && typeof d === 'object')
  }

  return {
    async collections() {
      const s = await store()
      const listed = await s.list({ prefix: 'db/', directories: true, paginate: true, consistency: 'strong' })
      const counts = new Map<string, number>()
      for (const b of listed.blobs) {
        const name = b.key.slice(3, b.key.indexOf('/', 3))
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return [...counts.entries()].map(([name, count]) => ({ name, count }))
    },
    collection<T>(coll: string): Collection<T> {
      return {
        async insert(doc) {
          const s = await store()
          const now = Date.now()
          const id = typeof doc._id === 'string' ? doc._id : newDocId()
          const saved = withMeta<T>(doc as Record<string, unknown>, id, now, now)
          try { await s.setJSON(docKey(coll, id), saved) } catch (e) { throw wrapErr(e, 'db insert') }
          return saved
        },
        async insertMany(docs) {
          const ids: string[] = []
          for (const d of docs) ids.push((await this.insert(d))._id)
          return ids
        },
        async get(id) {
          const s = await store()
          try { return ((await s.get(docKey(coll, id), { type: 'json', consistency: 'strong' })) as Doc<T> | null) ?? null } catch (e) { throw wrapErr(e, 'db get') }
        },
        async find(options) { return queryDocs(await all<T>(coll), options) },
        async findOne(filter, options) { return (await this.find({ ...options, filter, limit: 1 })).docs[0] ?? null },
        async count(filter) { return (await this.find({ filter, limit: 200 })).total },
        async update(id, input) {
          const cur = await this.get(id)
          if (!cur) {
            if (!input.upsert) return null
            return this.insert({ ...(input.set ?? {}), _id: id } as never)
          }
          const next = applyUpdate(cur, input)
          const s = await store()
          try { await s.setJSON(docKey(coll, id), next) } catch (e) { throw wrapErr(e, 'db update') }
          return next
        },
        async replace(id, doc) {
          const cur = await this.get(id)
          const saved = withMeta<T>(doc as Record<string, unknown>, id, cur?._createdAt ?? Date.now(), Date.now())
          const s = await store()
          try { await s.setJSON(docKey(coll, id), saved) } catch (e) { throw wrapErr(e, 'db replace') }
          return saved
        },
        async delete(id) {
          const existed = (await this.get(id)) !== null
          const s = await store()
          try { await s.delete(docKey(coll, id)) } catch (e) { throw wrapErr(e, 'db delete') }
          return existed
        },
        async deleteMany(filter) {
          const s = await store()
          const docs = (await this.find({ filter, limit: 200 })).docs
          for (const d of docs) await s.delete(docKey(coll, d._id)).catch(() => undefined)
          return docs.length
        },
        async drop() {
          const s = await store()
          for (const d of await all<T>(coll)) await s.delete(docKey(coll, d._id)).catch(() => undefined)
        },
      }
    },
  }
}
