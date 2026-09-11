import { configVersion, resolveConfig, type EdgeoneConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'
import { getKv } from './kv.js'
import { edgeoneDb } from './edgeone.js'
import { sqliteDb } from './sqlite.js'

/**
 * 文档集合（技术方案 19）：比 kv 更适合"列表 + 条件查询 + 排序分页"的业务数据。
 * 平台托管（platform）走 Data API `/data/v1/db/*`；edgeone 用 Pages Blob 每文档一个对象；sqlite 落本地文件（技术方案 33）；memory 为本地降级。
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

/** 聚合的分组键：字段原值（字符串/数字/布尔）、时间桶名，或"没有分组/字段缺失"的 null */
export type AggregateKey = string | number | boolean | null

/** 聚合指标（都返回数字）：计数、求和、均值、最小、最大、去重计数 */
export type AggregateMetric =
  | { $count: true }
  | { $sum: string }
  | { $avg: string }
  | { $min: string }
  | { $max: string }
  | { $countDistinct: string }

/** 时间分桶：把毫秒时间戳（或可解析的日期字符串）字段按小时/天/周/月归组 */
export interface AggregateGroup {
  field: string
  unit?: 'hour' | 'day' | 'week' | 'month'
  /** 时区偏移分钟，**默认 480（北京时间）**；按 UTC 分天传 0 */
  tzOffsetMinutes?: number
}

export interface AggregateOptions<T = Record<string, unknown>, M extends Record<string, AggregateMetric> = Record<string, AggregateMetric>> {
  /** 先筛（与 find 同一套过滤语法） */
  filter?: Filter<T>
  /** 分组字段（支持 a.b 点路径）或时间分桶；不传 = 整个集合一行 */
  groupBy?: string | AggregateGroup
  metrics: M
  /** 按指标名或 'key' 排序；默认 { key: 1 } */
  sort?: Record<string, 1 | -1>
  /** 返回的分组数，默认 100、上限 1000 */
  limit?: number
}

export type AggregateRow<M extends Record<string, AggregateMetric> = Record<string, AggregateMetric>> = { key: AggregateKey } & Record<keyof M, number>

export interface Collection<T = Record<string, unknown>> {
  insert(doc: Partial<T> & Record<string, unknown>): Promise<Doc<T>>
  insertMany(docs: Array<Partial<T> & Record<string, unknown>>): Promise<string[]>
  get(id: string): Promise<Doc<T> | null>
  find(options?: FindOptions<T>): Promise<FindResult<T>>
  /** 取第一条匹配（等价 find({filter, limit:1}).docs[0]） */
  findOne(filter?: Filter<T>, options?: Omit<FindOptions<T>, 'filter' | 'limit'>): Promise<Doc<T> | null>
  count(filter?: Filter<T>): Promise<number>
  /**
   * 聚合统计（技术方案 35）：分组在**服务端**完成，只拿回几行——看板/报表别再 `find` 全量回来自己 reduce。
   * ```ts
   * const byDay = await orders.aggregate({
   *   filter: { status: 'paid' },
   *   groupBy: { field: '_createdAt', unit: 'day' },   // 默认按北京时间分天
   *   metrics: { n: { $count: true }, total: { $sum: 'amount' } },
   * })   // → [{ key: '2026-01-01', n: 12, total: 3400 }, …]
   * ```
   */
  aggregate<M extends Record<string, AggregateMetric>>(options: AggregateOptions<T, M>): Promise<AggregateRow<M>[]>
  update(id: string, input: UpdateInput<T>): Promise<Doc<T> | null>
  /**
   * 条件更新（乐观锁，技术方案 34 §2）：当前文档满足 ifMatch 才更新，**不满足返回 null**（不是抛错）。
   * 把"先判断再写"的判断交给服务端，避免并发下超卖/重复处理：
   * ```ts
   * const ok = await seats.updateIf(id, { inc: { left: -1 } }, { left: { $gt: 0 }, status: 'open' })
   * if (!ok) return { error: '名额已满' }
   * ```
   * 并发写太密集（重试 5 次仍失败）时抛 AppSdkError('CONFLICT')。
   */
  updateIf(id: string, input: UpdateInput<T>, ifMatch: Filter<T>): Promise<Doc<T> | null>
  /**
   * 按 filter 找，找不到才插入 doc（技术方案 34 §2）。替代"`findOne` 没有就 `insert`"——后者并发下会插出两条。
   * 平台 / edgeone 驱动会先取一把同名锁再查再写。
   */
  getOrCreate(filter: Filter<T>, doc: Partial<T> & Record<string, unknown>): Promise<{ doc: Doc<T>; created: boolean }>
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
        async aggregate(options) {
          const r = await call<{ rows: any[] }>('POST', `${base}/aggregate`, {
            filter: options.filter, groupBy: options.groupBy, metrics: options.metrics, sort: options.sort, limit: options.limit,
          })
          return r.rows
        },
        async update(id, input) {
          const r = await call<{ doc: Doc<T> } | null>('PATCH', `${base}/${enc(id)}`, input)
          return r?.doc ?? null
        },
        async updateIf(id, input, ifMatch) {
          try {
            const r = await call<{ doc: Doc<T> } | null>('PATCH', `${base}/${enc(id)}`, { ...input, upsert: false, ifMatch })
            return r?.doc ?? null
          } catch (e) {
            // 条件不满足是正常结果（返回 null）；CONFLICT（重试耗尽）仍然抛出去让调用方重试
            if (e instanceof AppSdkError && e.code === 'PRECONDITION_FAILED') return null
            throw e
          }
        },
        getOrCreate(filter, doc) { return getOrCreateWith<T>(this, name, filter, doc) },
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

/** C# 侧用 MidpointRounding.AwayFromZero，这里对齐；只保留 4 位小数，避免 0.1+0.2 那种尾巴 */
function roundMetric(v: number): number {
  const sign = v < 0 ? -1 : 1
  return (sign * Math.round(Math.abs(v) * 1e4)) / 1e4
}

function aggregateKeyOf(value: unknown): AggregateKey {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value as AggregateKey
  return JSON.stringify(value)
}

/** 时间分桶：毫秒时间戳或可解析的日期字符串 → 按 tz 偏移后的桶名（与服务端同格式） */
function timeBucket(value: unknown, unit: string, tzOffsetMinutes: number): string | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms + tzOffsetMinutes * 60_000)   // 偏移后用 UTC getter 读，等价于"那个时区的本地时间"
  const p = (n: number) => String(n).padStart(2, '0')
  const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  if (unit === 'month') return ymd.slice(0, 7)
  if (unit === 'hour') return `${ymd} ${p(d.getUTCHours())}:00`
  if (unit === 'week') {
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000)
    return `${monday.getUTCFullYear()}-${p(monday.getUTCMonth() + 1)}-${p(monday.getUTCDate())}`
  }
  return ymd
}

function compareAggregate(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1   // null 排后面
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1
  return String(a) < String(b) ? -1 : String(a) === String(b) ? 0 : 1
}

/** 在一组内存文档上执行 aggregate（memory / sqlite / edgeone 驱动共用，语义与服务端一致） */
export function aggregateDocs<T, M extends Record<string, AggregateMetric>>(all: Doc<T>[], options: AggregateOptions<T, M>): AggregateRow<M>[] {
  const metrics = Object.entries(options.metrics ?? {}).map(([name, spec]) => {
    const [op, arg] = Object.entries(spec ?? {})[0] ?? []
    if (op === '$count') return { name, op, field: null as string | null }
    if ((op === '$sum' || op === '$avg' || op === '$min' || op === '$max' || op === '$countDistinct') && typeof arg === 'string' && arg) {
      return { name, op, field: arg }
    }
    throw new AppSdkError('INVALID_METRICS', `aggregate: 不支持的指标 ${name}: ${JSON.stringify(spec)}`, 400)
  })
  if (metrics.length === 0) throw new AppSdkError('INVALID_METRICS', 'aggregate: metrics 不能为空', 400)

  const group = typeof options.groupBy === 'string' ? { field: options.groupBy } as AggregateGroup : options.groupBy
  if (group && !group.field) throw new AppSdkError('INVALID_GROUP_BY', 'aggregate: groupBy.field 不能为空', 400)
  if (group?.unit && !['hour', 'day', 'week', 'month'].includes(group.unit)) {
    throw new AppSdkError('INVALID_GROUP_BY', `aggregate: 不支持的时间单位 ${group.unit}`, 400)
  }
  const tz = group?.tzOffsetMinutes ?? 480

  interface State { key: AggregateKey; count: number; sum: number[]; n: number[]; min: number[]; max: number[]; distinct: Array<Set<string> | null> }
  const states = new Map<string, State>()
  for (const doc of all) {
    if (options.filter && !matchesFilter(doc, options.filter)) continue
    let id = '*'
    let key: AggregateKey = null
    if (group) {
      const raw = resolvePath(doc, group.field)
      key = group.unit ? timeBucket(raw, group.unit, tz) : aggregateKeyOf(raw)
      id = key === null ? 'null' : `${typeof key}:${key}`   // typeof 不会等于 'null'，不会撞
    }
    let st = states.get(id)
    if (!st) {
      st = { key, count: 0, sum: metrics.map(() => 0), n: metrics.map(() => 0), min: metrics.map(() => 0), max: metrics.map(() => 0), distinct: metrics.map(() => null) }
      states.set(id, st)
    }
    st.count++
    metrics.forEach((m, i) => {
      if (m.op === '$count' || !m.field) return
      const value = resolvePath(doc, m.field)
      if (value === null || value === undefined) return
      if (m.op === '$countDistinct') {
        (st!.distinct[i] ??= new Set<string>()).add(typeof value === 'string' ? value : JSON.stringify(value))
        return
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      st!.n[i]!++
      st!.sum[i]! += value
      st!.min[i] = st!.n[i] === 1 ? value : Math.min(st!.min[i]!, value)
      st!.max[i] = st!.n[i] === 1 ? value : Math.max(st!.max[i]!, value)
    })
  }

  const rows = [...states.values()].map(st => {
    const row: Record<string, unknown> = { key: st.key }
    metrics.forEach((m, i) => {
      row[m.name] =
        m.op === '$count' ? st.count
        : m.op === '$countDistinct' ? (st.distinct[i]?.size ?? 0)
        : st.n[i] === 0 ? 0
        : m.op === '$sum' ? roundMetric(st.sum[i]!)
        : m.op === '$avg' ? roundMetric(st.sum[i]! / st.n[i]!)
        : m.op === '$min' ? roundMetric(st.min[i]!)
        : roundMetric(st.max[i]!)
    })
    return row as AggregateRow<M>
  })

  const sortKeys = Object.entries(options.sort ?? { key: 1 })
  rows.sort((a, b) => {
    for (const [field, dir] of sortKeys) {
      const c = compareAggregate((a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field])
      if (c !== 0) return dir < 0 ? -c : c
    }
    return 0
  })
  return rows.slice(0, Math.min(Math.max(1, options.limit ?? 100), 1000))
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

/** filter 的稳定短哈希（键序无关），用来给 getOrCreate 生成同名锁的键 */
function stableHash(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v)
  let h = 2166136261
  for (let i = 0; i < (json ?? '').length; i++) { h ^= json!.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

/**
 * getOrCreate 的公共实现：先拿一把 `db:{集合}:{filter 哈希}` 的 kv 锁，让"同一条件"的并发请求串行，锁内查不到才插入。
 * 单进程驱动（memory / sqlite）同样要锁——await 之间照样会交错，两个请求都查不到就会插出两条。
 */
export async function getOrCreateWith<T>(
  c: Collection<T>, name: string, filter: Filter<T>, doc: Partial<T> & Record<string, unknown>,
): Promise<{ doc: Doc<T>; created: boolean }> {
  const lock = await getKv().lock(`db:${name}:${stableHash(filter)}`, { ttlMs: 10_000, waitMs: 3000 })
  if (!lock) throw new AppSdkError('CONFLICT', `getOrCreate("${name}") 等锁超时，请重试`, 409)
  try {
    const found = await c.findOne(filter)
    if (found) return { doc: found, created: false }
    return { doc: await c.insert(doc), created: true }
  } finally {
    await lock.release()
  }
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
        async aggregate(options) { return aggregateDocs([...m().values()], options) },
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
        async updateIf(id, input, ifMatch) {
          const cur = m().get(id)
          if (!cur || !matchesFilter(cur, ifMatch)) return null
          const next = applyUpdate(cur, input)
          m().set(id, next)
          return next
        },
        getOrCreate(filter, doc) { return getOrCreateWith<T>(this, name, filter, doc) },
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
  // 并入 configure() 次数：换 fetchImpl / 换配置时重建，不会拿到上一份闭包
  const key = `${configVersion()}|` + (
    cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}`
    : cfg.kind === 'edgeone' ? `edgeone|${cfg.kvStore}|${cfg.projectId ?? ''}`
    : cfg.kind === 'sqlite' ? `sqlite|${cfg.path}`
    : 'memory')
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client:
        cfg.kind === 'platform' ? platformDb(cfg)
        : cfg.kind === 'edgeone' ? edgeoneDb(cfg as EdgeoneConfig)
        : cfg.kind === 'sqlite' ? sqliteDb(cfg)
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
