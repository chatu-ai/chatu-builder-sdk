import { resolveConfig, type EdgeoneConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'
import { edgeoneDb } from './edgeone.js'

/**
 * 文档集合（技术方案 19）：比 kv 更适合"列表 + 条件查询 + 排序分页"的业务数据。
 * 平台托管（platform）走 Data API `/data/v1/db/*`；edgeone 用 Pages Blob 每文档一个对象；memory 为本地降级。
 * 只能在服务端使用。
 */

/** 文档：应用自定义字段 + 平台补充的 _id/_createdAt/_updatedAt（毫秒时间戳） */
export type Doc<T> = T & { _id: string; _createdAt: number; _updatedAt: number }

export type FilterOp<V = unknown> = {
  $gt?: V
  $gte?: V
  $lt?: V
  $lte?: V
  $ne?: V
  $in?: V[]
  $nin?: V[]
  /** 字符串包含（不区分大小写）；数组字段则表示"包含某元素" */
  $contains?: V extends Array<infer E> ? E : V
  $exists?: boolean
}
/** 过滤：{字段: 值} 等值；{字段: {$gt: 1}} 操作符；$and/$or/$not 组合；字段支持 a.b 点路径 */
export type Filter<T = Record<string, unknown>> =
  | ({ [K in keyof T]?: T[K] | FilterOp<T[K]> } & { [key: string]: unknown })
  | { $and?: Filter<T>[]; $or?: Filter<T>[]; $not?: Filter<T> }

export type Sort = Record<string, 1 | -1>

export interface FindOptions<T = Record<string, unknown>> {
  filter?: Filter<T>
  sort?: Sort
  skip?: number
  /** 单页上限 200，默认 50 */
  limit?: number
}
export interface FindResult<T> {
  docs: Doc<T>[]
  /** 满足 filter 的总数 */
  total: number
  /** 还有下一页时为下一次的 skip，否则 null */
  nextSkip: number | null
}
export interface UpdateInput<T> {
  set?: Partial<T> & Record<string, unknown>
  unset?: string[]
  /** 数值字段增减：{ views: 1 } */
  inc?: Record<string, number>
  /** 不存在时创建（默认 false） */
  upsert?: boolean
}

export interface Collection<T = Record<string, unknown>> {
  insert(doc: Partial<T> & Record<string, unknown>): Promise<Doc<T>>
  insertMany(docs: Array<Partial<T> & Record<string, unknown>>): Promise<string[]>
  get(id: string): Promise<Doc<T> | null>
  find(options?: FindOptions<T>): Promise<FindResult<T>>
  /** 取第一条匹配（等价 find({filter, limit:1}).docs[0]） */
  findOne(filter?: Filter<T>, options?: Omit<FindOptions<T>, 'filter' | 'limit'>): Promise<Doc<T> | null>
  count(filter?: Filter<T>): Promise<number>
  update(id: string, input: UpdateInput<T>): Promise<Doc<T> | null>
  replace(id: string, doc: Partial<T> & Record<string, unknown>): Promise<Doc<T>>
  delete(id: string): Promise<boolean>
  deleteMany(filter?: Filter<T>): Promise<number>
  /** 清空集合 */
  drop(): Promise<void>
}

export interface DbClient {
  collection<T = Record<string, unknown>>(name: string): Collection<T>
  collections(): Promise<Array<{ name: string; count: number }>>
}

// ---------- platform driver ----------
function platformDb(cfg: PlatformConfig): DbClient {
  const headers = { 'x-api-key': cfg.apiKey, 'x-chatu-env': cfg.env, 'content-type': 'application/json' }
  async function call<R>(method: string, path: string, body?: unknown): Promise<R> {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}/db${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: any = null
    try { json = await res.json() } catch { /* ignore */ }
    if (!res.ok || json?.ok === false) {
      if (res.status === 404 && json?.error === 'NOT_FOUND') return null as R
      throw new AppSdkError(json?.error ?? `HTTP_${res.status}`, json?.message ?? `db ${method} ${path} failed (${res.status})`, res.status)
    }
    return json as R
  }
  const enc = (s: string) => encodeURIComponent(s)
  return {
    collections: async () => (await call<{ collections: Array<{ name: string; count: number }> }>('GET', '')).collections,
    collection<T>(name: string): Collection<T> {
      const base = `/${enc(name)}`
      return {
        async insert(doc) {
          const r = await call<{ ids: string[] }>('POST', base, { doc })
          const saved = await this.get(r.ids[0]!)
          if (!saved) throw new AppSdkError('INSERT_FAILED', 'inserted doc not found')
          return saved
        },
        async insertMany(docs) {
          if (docs.length === 0) return []
          return (await call<{ ids: string[] }>('POST', base, { docs })).ids
        },
        async get(id) {
          const r = await call<{ doc: Doc<T> | null; exists: boolean }>('GET', `${base}/${enc(id)}`)
          return r?.exists ? r.doc : null
        },
        async find(options) {
          const r = await call<{ docs: Doc<T>[]; total: number; nextSkip: number | null }>('POST', `${base}/query`, {
            filter: options?.filter, sort: options?.sort, skip: options?.skip, limit: options?.limit,
          })
          return { docs: r.docs, total: r.total, nextSkip: r.nextSkip ?? null }
        },
        async findOne(filter, options) {
          const r = await this.find({ ...options, filter, limit: 1 })
          return r.docs[0] ?? null
        },
        async count(filter) {
          const q = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : ''
          return (await call<{ count: number }>('GET', `${base}/count${q}`)).count
        },
        async update(id, input) {
          const r = await call<{ doc: Doc<T> } | null>('PATCH', `${base}/${enc(id)}`, input)
          return r?.doc ?? null
        },
        async replace(id, doc) {
          return (await call<{ doc: Doc<T> }>('PUT', `${base}/${enc(id)}`, doc)).doc
        },
        async delete(id) {
          return (await call<{ removed: boolean }>('DELETE', `${base}/${enc(id)}`)).removed
        },
        async deleteMany(filter) {
          return (await call<{ removed: number }>('POST', `${base}/delete-many`, { filter: filter ?? {} })).removed
        },
        async drop() { await call('DELETE', base) },
      }
    },
  }
}

// ---------- 共享：内存过滤 / 排序（memory 与 edgeone 驱动复用） ----------

function resolvePath(doc: any, path: string): unknown {
  let cur: any = doc
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1
  return null
}

export function matchesFilter(doc: unknown, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return true
  for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '$and') {
      if (!Array.isArray(expected) || !expected.every(f => matchesFilter(doc, f))) return false
      continue
    }
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some(f => matchesFilter(doc, f))) return false
      continue
    }
    if (key === '$not') {
      if (matchesFilter(doc, expected)) return false
      continue
    }
    const actual = resolvePath(doc, key)
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).some(k => k.startsWith('$'))) {
      for (const [op, v] of Object.entries(expected as Record<string, unknown>)) {
        switch (op) {
          case '$exists': if ((actual !== undefined) !== !!v) return false; break
          case '$ne': if (eq(actual, v)) return false; break
          case '$in': if (!Array.isArray(v) || !v.some(x => eq(actual, x))) return false; break
          case '$nin': if (Array.isArray(v) && v.some(x => eq(actual, x))) return false; break
          case '$gt': case '$gte': case '$lt': case '$lte': {
            const c = cmp(actual, v)
            if (c === null) return false
            if (op === '$gt' && !(c > 0)) return false
            if (op === '$gte' && !(c >= 0)) return false
            if (op === '$lt' && !(c < 0)) return false
            if (op === '$lte' && !(c <= 0)) return false
            break
          }
          case '$contains':
            if (typeof actual === 'string') {
              if (!actual.toLowerCase().includes(String(v).toLowerCase())) return false
            } else if (Array.isArray(actual)) {
              if (!actual.some(x => eq(x, v))) return false
            } else return false
            break
          default: return false
        }
      }
      continue
    }
    if (!eq(actual, expected)) return false
  }
  return true
}

export function applySort<T>(docs: T[], sort?: Sort): T[] {
  if (!sort || Object.keys(sort).length === 0) return docs
  const keys = Object.entries(sort)
  return [...docs].sort((x, y) => {
    for (const [field, dir] of keys) {
      const a = resolvePath(x, field)
      const b = resolvePath(y, field)
      let c: number
      if (a === undefined && b === undefined) c = 0
      else if (a === undefined) c = -1
      else if (b === undefined) c = 1
      else c = cmp(a, b) ?? (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) === JSON.stringify(b) ? 0 : 1)
      if (c !== 0) return dir < 0 ? -c : c
    }
    return 0
  })
}

/** 时间有序 id（与服务端同格式） */
export function newDocId(): string {
  return Date.now().toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 10)
}

export function withMeta<T>(doc: Record<string, unknown>, id: string, createdAt: number, updatedAt: number): Doc<T> {
  const { _id: _i, _createdAt: _c, _updatedAt: _u, ...rest } = doc as Record<string, unknown>
  return { _id: id, _createdAt: createdAt, _updatedAt: updatedAt, ...rest } as Doc<T>
}

/** 在一组内存文档上执行 find（memory / edgeone 驱动共用） */
export function queryDocs<T>(all: Doc<T>[], options?: FindOptions<T>): FindResult<T> {
  const matched = all.filter(d => matchesFilter(d, options?.filter))
  const sorted = applySort(matched, options?.sort)
  const skip = Math.max(0, options?.skip ?? 0)
  const limit = Math.min(Math.max(1, options?.limit ?? 50), 200)
  const page = sorted.slice(skip, skip + limit)
  return { docs: page, total: sorted.length, nextSkip: skip + page.length < sorted.length ? skip + page.length : null }
}

/** 对已有文档应用 set/unset/inc */
export function applyUpdate<T>(current: Doc<T>, input: UpdateInput<T>): Doc<T> {
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) }
  if (input.set) Object.assign(next, input.set)
  for (const f of input.unset ?? []) delete next[f]
  for (const [f, delta] of Object.entries(input.inc ?? {})) {
    const cur = typeof next[f] === 'number' ? (next[f] as number) : 0
    next[f] = cur + delta
  }
  return withMeta<T>(next, current._id, current._createdAt, Date.now())
}

// ---------- memory driver ----------
function memoryDb(): DbClient {
  const store = new Map<string, Map<string, Doc<any>>>()
  const of = (name: string) => {
    let m = store.get(name)
    if (!m) { m = new Map(); store.set(name, m) }
    return m
  }
  return {
    async collections() {
      return [...store.entries()].filter(([, m]) => m.size > 0).map(([name, m]) => ({ name, count: m.size }))
    },
    collection<T>(name: string): Collection<T> {
      const m = () => of(name) as Map<string, Doc<T>>
      return {
        async insert(doc) {
          const now = Date.now()
          const id = typeof doc._id === 'string' ? doc._id : newDocId()
          const saved = withMeta<T>(doc as Record<string, unknown>, id, now, now)
          m().set(id, saved)
          return saved
        },
        async insertMany(docs) {
          const ids: string[] = []
          for (const d of docs) ids.push((await this.insert(d))._id)
          return ids
        },
        async get(id) { return m().get(id) ?? null },
        async find(options) { return queryDocs([...m().values()], options) },
        async findOne(filter, options) { return (await this.find({ ...options, filter, limit: 1 })).docs[0] ?? null },
        async count(filter) { return [...m().values()].filter(d => matchesFilter(d, filter)).length },
        async update(id, input) {
          const cur = m().get(id)
          if (!cur) {
            if (!input.upsert) return null
            return this.insert({ ...(input.set ?? {}), _id: id } as any)
          }
          const next = applyUpdate(cur, input)
          m().set(id, next)
          return next
        },
        async replace(id, doc) {
          const cur = m().get(id)
          const saved = withMeta<T>(doc as Record<string, unknown>, id, cur?._createdAt ?? Date.now(), Date.now())
          m().set(id, saved)
          return saved
        },
        async delete(id) { return m().delete(id) },
        async deleteMany(filter) {
          let n = 0
          for (const [id, d] of [...m().entries()]) if (matchesFilter(d, filter)) { m().delete(id); n++ }
          return n
        },
        async drop() { store.delete(name) },
      }
    },
  }
}

let cached: { key: string; client: DbClient } | null = null

export function getDb(): DbClient {
  const cfg = resolveConfig()
  const key =
    cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}`
    : cfg.kind === 'edgeone' ? `edgeone|${cfg.kvStore}|${cfg.projectId ?? ''}`
    : 'memory'
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client:
        cfg.kind === 'platform' ? platformDb(cfg)
        : cfg.kind === 'edgeone' ? edgeoneDb(cfg as EdgeoneConfig)
        : memoryDb(),
    }
  }
  return cached.client
}

/** 便捷单例：`import { db } from '@chatu-ai/app-sdk'` */
export const db: DbClient = {
  collection: <T>(name: string) => getDb().collection<T>(name),
  collections: () => getDb().collections(),
}
