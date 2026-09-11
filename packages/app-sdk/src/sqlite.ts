import type { SqliteConfig } from './config.js'
import { optionalImport } from './config.js'
import { AppSdkError } from './errors.js'
import type { KvDriver } from './kv.js'
import { applyUpdate, getOrCreateWith, matchesFilter, newDocId, queryDocs, withMeta, type Collection, type DbClient, type Doc } from './db.js'

/**
 * 本地 SQLite 驱动（技术方案 33；CHATU_DATA_DRIVER=sqlite）：db 与 kv 落到同一个文件，引擎是 Node 内置 `node:sqlite`（≥ 22.13），零 npm 依赖。
 * - 通过 `process.getBuiltinModule()`（Node ≥ 22.3，同步、打包器不会静态解析）加载内置模块，没有时退 optionalImport；Node 太旧时抛 SQLITE_UNAVAILABLE。
 * - docs 表一张表放所有集合（collection + id 主键，body 为不含 _ 元字段的 JSON）；查询与 memory / edgeone 驱动一样"取出集合全量 → 内存过滤排序分页"，
 *   语义与其它驱动完全一致，万级以内够用（更大就该用平台托管）。
 * - kv 表：value 为 JSON，expires_at 毫秒时间戳；读取时惰性清过期。
 * - journal_mode=DELETE 而非 WAL：沙箱工作区是网络盘（CFS），WAL 依赖共享内存在网络盘上不可靠。
 * - 单机单实例：一个文件一个进程写；不能部署到 EdgeOne Pages / 云函数（无持久磁盘）。
 */

type Stmt = { run(...args: unknown[]): { changes: number | bigint }; get(...args: unknown[]): any; all(...args: unknown[]): any[] }
type Database = { exec(sql: string): void; prepare(sql: string): Stmt }

const HINT = 'Node.js 22.13+ 才内置 node:sqlite；请升级 Node，或去掉 CHATU_DATA_DRIVER=sqlite 改用平台托管'

const opened = new Map<string, Promise<Database>>()

/** 取 Node 内置模块：优先 process.getBuiltinModule（vitest 的 vm 沙箱里动态 import 不可用），否则退 optionalImport（含测试预注册） */
async function builtin<T = any>(name: string): Promise<T> {
  const get = (globalThis as any).process?.getBuiltinModule as ((n: string) => T | undefined) | undefined
  if (typeof get === 'function') {
    try {
      const m = get(name)
      if (m) return m
    } catch { /* 不存在的内置模块：走下面的 optionalImport 报错 */ }
  }
  return optionalImport<T>(name, HINT)
}

/** 按路径缓存的连接（进程内单例）；父目录不存在时自动创建 */
async function open(cfg: SqliteConfig): Promise<Database> {
  let p = opened.get(cfg.path)
  if (!p) {
    p = (async () => {
      let mod: any, fs: any, path: any
      try {
        ;[mod, fs, path] = await Promise.all([builtin('node:sqlite'), builtin('node:fs'), builtin('node:path')])
      } catch (err) {
        const e = new AppSdkError('SQLITE_UNAVAILABLE', `@chatu-ai/app-sdk: ${HINT}`)
        e.details = { cause: String((err as Error)?.message ?? err) }
        throw e
      }
      const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync
      if (typeof DatabaseSync !== 'function') throw new AppSdkError('SQLITE_UNAVAILABLE', `@chatu-ai/app-sdk: node:sqlite 缺少 DatabaseSync；${HINT}`)
      fs.mkdirSync(path.dirname(cfg.path), { recursive: true })
      const db: Database = new DatabaseSync(cfg.path)
      db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA busy_timeout=5000;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS docs(
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(collection, id)
        );
        CREATE TABLE IF NOT EXISTS kv(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER
        );
      `)
      return db
    })()
    opened.set(cfg.path, p)
    p.catch(() => opened.delete(cfg.path))
  }
  return p
}

/** 测试/热重载用：关闭并遗忘某路径的连接缓存（不删文件） */
export function forgetSqlite(path?: string): void {
  if (path) opened.delete(path)
  else opened.clear()
}

function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}

/** 去掉 _ 元字段后的 JSON（元字段由列承载） */
function bodyOf(doc: Record<string, unknown>): string {
  const { _id: _i, _createdAt: _c, _updatedAt: _u, ...rest } = doc
  return JSON.stringify(rest)
}

function rowToDoc<T>(row: { id: string; body: string; created_at: number | bigint; updated_at: number | bigint }): Doc<T> {
  return withMeta<T>(JSON.parse(row.body), row.id, Number(row.created_at), Number(row.updated_at))
}

// ---------- db ----------
export function sqliteDb(cfg: SqliteConfig): DbClient {
  return {
    async collections() {
      const db = await open(cfg)
      return db.prepare('SELECT collection AS name, COUNT(*) AS count FROM docs GROUP BY collection ORDER BY collection').all()
        .map(r => ({ name: String(r.name), count: Number(r.count) }))
    },
    collection<T>(name: string): Collection<T> {
      const loadAll = (db: Database): Doc<T>[] =>
        db.prepare('SELECT id, body, created_at, updated_at FROM docs WHERE collection = ?').all(name).map(r => rowToDoc<T>(r))
      const insertOne = (db: Database, doc: Record<string, unknown>): Doc<T> => {
        const now = Date.now()
        const id = typeof doc._id === 'string' && doc._id ? doc._id : newDocId()
        // 与 memory 驱动一致：同 _id 再插入视为覆盖
        db.prepare('INSERT OR REPLACE INTO docs(collection, id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, id, bodyOf(doc), now, now)
        return withMeta<T>(doc, id, now, now)
      }
      const getOne = (db: Database, id: string): Doc<T> | null => {
        const row = db.prepare('SELECT id, body, created_at, updated_at FROM docs WHERE collection = ? AND id = ?').get(name, id)
        return row ? rowToDoc<T>(row) : null
      }
      return {
        async insert(doc) {
          const db = await open(cfg)
          return insertOne(db, doc as Record<string, unknown>)
        },
        async insertMany(docs) {
          if (docs.length === 0) return []
          const db = await open(cfg)
          return transaction(db, () => docs.map(d => insertOne(db, d as Record<string, unknown>)._id))
        },
        async get(id) {
          const db = await open(cfg)
          return getOne(db, id)
        },
        async find(options) {
          const db = await open(cfg)
          return queryDocs(loadAll(db), options)
        },
        async findOne(filter, options) {
          return (await this.find({ ...options, filter, limit: 1 })).docs[0] ?? null
        },
        async count(filter) {
          const db = await open(cfg)
          if (!filter || Object.keys(filter).length === 0) {
            return Number(db.prepare('SELECT COUNT(*) AS n FROM docs WHERE collection = ?').get(name)?.n ?? 0)
          }
          return loadAll(db).filter(d => matchesFilter(d, filter)).length
        },
        async update(id, input) {
          const db = await open(cfg)
          return transaction(db, () => {
            const cur = getOne(db, id)
            if (!cur) {
              if (!input.upsert) return null
              return insertOne(db, { ...(input.set ?? {}), _id: id })
            }
            const next = applyUpdate(cur, input)
            db.prepare('UPDATE docs SET body = ?, updated_at = ? WHERE collection = ? AND id = ?').run(bodyOf(next as Record<string, unknown>), next._updatedAt, name, id)
            return next
          })
        },
        async updateIf(id, input, ifMatch) {
          const db = await open(cfg)
          return transaction(db, () => {
            const cur = getOne(db, id)
            if (!cur || !matchesFilter(cur, ifMatch)) return null
            const next = applyUpdate(cur, input)
            db.prepare('UPDATE docs SET body = ?, updated_at = ? WHERE collection = ? AND id = ?').run(bodyOf(next as Record<string, unknown>), next._updatedAt, name, id)
            return next
          })
        },
        getOrCreate(filter, doc) { return getOrCreateWith<T>(this, name, filter, doc) },
        async replace(id, doc) {
          const db = await open(cfg)
          return transaction(db, () => {
            const cur = getOne(db, id)
            const now = Date.now()
            const createdAt = cur?._createdAt ?? now
            db.prepare('INSERT OR REPLACE INTO docs(collection, id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, id, bodyOf(doc as Record<string, unknown>), createdAt, now)
            return withMeta<T>(doc as Record<string, unknown>, id, createdAt, now)
          })
        },
        async delete(id) {
          const db = await open(cfg)
          return Number(db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(name, id).changes) > 0
        },
        async deleteMany(filter) {
          const db = await open(cfg)
          if (!filter || Object.keys(filter).length === 0) {
            return Number(db.prepare('DELETE FROM docs WHERE collection = ?').run(name).changes)
          }
          return transaction(db, () => {
            const ids = loadAll(db).filter(d => matchesFilter(d, filter)).map(d => d._id)
            const stmt = db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?')
            let n = 0
            for (const id of ids) n += Number(stmt.run(name, id).changes)
            return n
          })
        },
        async drop() {
          const db = await open(cfg)
          db.prepare('DELETE FROM docs WHERE collection = ?').run(name)
        },
      }
    },
  }
}

// ---------- kv ----------
export function sqliteKv(cfg: SqliteConfig): KvDriver {
  /** 读一条未过期的记录；过期则顺手删掉 */
  const live = (db: Database, key: string): { value: unknown; expiresAt: number | null } | null => {
    const row = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key)
    if (!row) return null
    const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at)
    if (expiresAt !== null && Date.now() > expiresAt) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key)
      return null
    }
    return { value: JSON.parse(row.value), expiresAt }
  }
  const put = (db: Database, key: string, value: unknown, expiresAt: number | null) =>
    db.prepare('INSERT OR REPLACE INTO kv(key, value, expires_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value ?? null), expiresAt)
  return {
    async get(key) {
      const db = await open(cfg)
      return (live(db, key)?.value as any) ?? null
    },
    async set(key, value, opts) {
      const db = await open(cfg)
      put(db, key, value, opts?.ex ? Date.now() + opts.ex * 1000 : null)
    },
    async setnx(key, value, opts) {
      const db = await open(cfg)
      return transaction(db, () => {
        if (live(db, key)) return false
        put(db, key, value, opts?.ex ? Date.now() + opts.ex * 1000 : null)
        return true
      })
    },
    async del(key) {
      const db = await open(cfg)
      return Number(db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes) > 0
    },
    async incr(key, by = 1) {
      const db = await open(cfg)
      return transaction(db, () => {
        const e = live(db, key)
        const cur = Number(e?.value ?? 0)
        if (!Number.isInteger(cur)) throw new AppSdkError('NOT_AN_INTEGER', 'value is not an integer')
        const next = cur + by
        put(db, key, next, e?.expiresAt ?? null)
        return next
      })
    },
    async expire(key, seconds) {
      const db = await open(cfg)
      if (!live(db, key)) return false
      db.prepare('UPDATE kv SET expires_at = ? WHERE key = ?').run(Date.now() + seconds * 1000, key)
      return true
    },
    async mget(keys) {
      const db = await open(cfg)
      return keys.map(k => (live(db, k)?.value as any) ?? null)
    },
    async list(prefix = '', opts) {
      const db = await open(cfg)
      const now = Date.now()
      const pattern = prefix.replace(/[\\%_]/g, ch => `\\${ch}`) + '%'
      const all = db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key").all(pattern, now).map(r => String(r.key))
      const start = opts?.cursor ? Number(opts.cursor) : 0
      const limit = opts?.limit ?? 100
      const page = all.slice(start, start + limit)
      return { keys: page, nextCursor: start + limit < all.length ? String(start + limit) : null }
    },
  }
}
