import { configVersion, resolveConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'

/** 应用自己的终端用户（与 ChatU 平台账号无关） */
export interface AppUser {
  id: string
  email: string
  name: string | null
  avatar: string | null
  createdAt: number
  lastLoginAt: number
  disabled: boolean
  meta: Record<string, unknown>
}

export interface SignInResult { token: string; user: AppUser; created: boolean }
export interface SendCodeResult { sent: boolean; /** 仅预览环境且平台未配置邮件通道时返回，便于调试 */ devCode?: string | null }
export interface UserListResult { users: AppUser[]; total: number; nextSkip: number | null }
export interface UserPatch { name?: string | null; avatar?: string | null; disabled?: boolean; meta?: Record<string, unknown>; password?: string }

export interface AuthClient {
  /** 发送邮箱登录验证码 */
  sendCode(email: string): Promise<SendCodeResult>
  /** 校验验证码；邮箱首次登录自动注册 */
  verifyCode(email: string, code: string, opts?: { name?: string }): Promise<SignInResult>
  /** 邮箱 + 密码注册 */
  register(email: string, password: string, opts?: { name?: string }): Promise<SignInResult>
  /** 邮箱 + 密码登录 */
  login(email: string, password: string): Promise<SignInResult>
  /** 用会话 token 换当前用户；无效/过期/被禁用返回 null */
  getSession(token: string | null | undefined): Promise<AppUser | null>
  /** 退出登录（吊销该 token） */
  signOut(token: string | null | undefined): Promise<boolean>
  users: {
    list(opts?: { skip?: number; limit?: number; keyword?: string }): Promise<UserListResult>
    get(id: string): Promise<AppUser | null>
    update(id: string, patch: UserPatch): Promise<AppUser>
    delete(id: string): Promise<boolean>
  }
}

// ---------- platform driver ----------
function platformAuth(cfg: PlatformConfig): AuthClient {
  const headers = { 'x-api-key': cfg.apiKey, 'x-chatu-env': cfg.env, 'content-type': 'application/json' }
  async function call<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}/auth${path}`, {
      method,
      headers: token ? { ...headers, 'x-app-session': token } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: any = null
    try { json = await res.json() } catch { /* ignore */ }
    if (!res.ok || json?.ok === false) {
      throw new AppSdkError(json?.error ?? `HTTP_${res.status}`, json?.message ?? `auth ${method} ${path} failed (${res.status})`, res.status)
    }
    return json as T
  }
  return {
    async sendCode(email) {
      const r = await call<{ sent: boolean; devCode?: string | null }>('POST', '/code/send', { email })
      return { sent: r.sent, devCode: r.devCode ?? null }
    },
    async verifyCode(email, code, opts) {
      const r = await call<{ token: string; user: AppUser; created: boolean }>('POST', '/code/verify', { email, code, name: opts?.name })
      return { token: r.token, user: r.user, created: r.created }
    },
    async register(email, password, opts) {
      const r = await call<{ token: string; user: AppUser; created: boolean }>('POST', '/password/register', { email, password, name: opts?.name })
      return { token: r.token, user: r.user, created: r.created }
    },
    async login(email, password) {
      const r = await call<{ token: string; user: AppUser }>('POST', '/password/login', { email, password })
      return { token: r.token, user: r.user, created: false }
    },
    async getSession(token) {
      if (!token) return null
      const r = await call<{ user: AppUser | null }>('GET', '/session', undefined, token)
      return r.user ?? null
    },
    async signOut(token) {
      if (!token) return false
      const r = await call<{ removed: boolean }>('POST', '/logout', {}, token)
      return r.removed
    },
    users: {
      async list(opts) {
        const q = new URLSearchParams({ skip: String(opts?.skip ?? 0), limit: String(opts?.limit ?? 50) })
        if (opts?.keyword) q.set('keyword', opts.keyword)
        const r = await call<{ users: AppUser[]; total: number; nextSkip: number | null }>('GET', `/users?${q.toString()}`)
        return { users: r.users, total: r.total, nextSkip: r.nextSkip ?? null }
      },
      async get(id) {
        try {
          const r = await call<{ user: AppUser }>('GET', `/users/${encodeURIComponent(id)}`)
          return r.user
        } catch (err) {
          if (err instanceof AppSdkError && err.code === 'USER_NOT_FOUND') return null
          throw err
        }
      },
      async update(id, patch) {
        const r = await call<{ user: AppUser }>('PATCH', `/users/${encodeURIComponent(id)}`, patch)
        return r.user
      },
      async delete(id) {
        const r = await call<{ removed: boolean }>('DELETE', `/users/${encodeURIComponent(id)}`)
        return r.removed
      },
    },
  }
}

// ---------- memory driver（本机开发 / 测试；进程退出即丢失） ----------
function memoryAuth(): AuthClient {
  const users = new Map<string, AppUser & { pwd?: string }>()
  /** 注册序号：同一毫秒创建的用户也要有稳定的先后顺序 */
  const seq = new Map<string, number>()
  let nextSeq = 0
  const byEmail = new Map<string, string>()
  const sessions = new Map<string, string>()
  const codes = new Map<string, string>()
  const norm = (email: string) => email.trim().toLowerCase()
  const strip = (u: AppUser & { pwd?: string }): AppUser => { const { pwd: _pwd, ...rest } = u; return rest }
  const issue = (id: string) => { const token = `mem_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; sessions.set(token, id); return token }
  const create = (email: string, name?: string, pwd?: string) => {
    const now = Date.now()
    const user = { id: `u${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, email, name: name ?? email.split('@')[0]!, avatar: null, createdAt: now, lastLoginAt: now, disabled: false, meta: {}, pwd }
    users.set(user.id, user)
    seq.set(user.id, nextSeq++)
    byEmail.set(email, user.id)
    return user
  }
  return {
    async sendCode(email) { const code = String(Math.floor(100000 + Math.random() * 900000)); codes.set(norm(email), code); return { sent: true, devCode: code } },
    async verifyCode(email, code, opts) {
      const key = norm(email)
      if (codes.get(key) !== code.trim()) throw new AppSdkError('CODE_INVALID', '验证码不正确')
      codes.delete(key)
      const existingId = byEmail.get(key)
      const user = existingId ? users.get(existingId)! : create(key, opts?.name)
      user.lastLoginAt = Date.now()
      return { token: issue(user.id), user: strip(user), created: !existingId }
    },
    async register(email, password, opts) {
      const key = norm(email)
      if (byEmail.has(key)) throw new AppSdkError('EMAIL_TAKEN', '该邮箱已注册')
      if (password.length < 6) throw new AppSdkError('WEAK_PASSWORD', '密码至少 6 位')
      const user = create(key, opts?.name, password)
      return { token: issue(user.id), user: strip(user), created: true }
    },
    async login(email, password) {
      const id = byEmail.get(norm(email))
      const user = id ? users.get(id) : undefined
      if (!user || user.pwd !== password) throw new AppSdkError('INVALID_CREDENTIALS', '邮箱或密码不正确')
      if (user.disabled) throw new AppSdkError('USER_DISABLED', '该账号已被停用')
      user.lastLoginAt = Date.now()
      return { token: issue(user.id), user: strip(user), created: false }
    },
    async getSession(token) {
      if (!token) return null
      const id = sessions.get(token)
      const user = id ? users.get(id) : undefined
      return !user || user.disabled ? null : strip(user)
    },
    async signOut(token) { return token ? sessions.delete(token) : false },
    users: {
      async list(opts) {
        const kw = opts?.keyword?.trim().toLowerCase()
        const all = [...users.values()]
          .filter(u => !kw || u.email.includes(kw) || (u.name ?? '').toLowerCase().includes(kw))
          .sort((a, b) => b.createdAt - a.createdAt || (seq.get(b.id) ?? 0) - (seq.get(a.id) ?? 0))
        const skip = opts?.skip ?? 0
        const limit = opts?.limit ?? 50
        const page = all.slice(skip, skip + limit)
        return { users: page.map(strip), total: all.length, nextSkip: skip + page.length < all.length ? skip + page.length : null }
      },
      async get(id) { const u = users.get(id); return u ? strip(u) : null },
      async update(id, patch) {
        const u = users.get(id)
        if (!u) throw new AppSdkError('USER_NOT_FOUND', '用户不存在')
        if (patch.name !== undefined) u.name = patch.name
        if (patch.avatar !== undefined) u.avatar = patch.avatar
        if (patch.meta !== undefined) u.meta = patch.meta
        if (patch.password !== undefined) u.pwd = patch.password
        if (patch.disabled !== undefined) {
          u.disabled = patch.disabled
          if (patch.disabled) for (const [t, uid] of [...sessions]) if (uid === id) sessions.delete(t)
        }
        return strip(u)
      },
      async delete(id) {
        const u = users.get(id)
        if (!u) return false
        for (const [t, uid] of [...sessions]) if (uid === id) sessions.delete(t)
        byEmail.delete(u.email)
        seq.delete(id)
        return users.delete(id)
      },
    },
  }
}

/** byo / edgeone 等驱动没有用户存储：每个方法都以明确错误 reject，而不是在取客户端时同步抛出 */
function unsupportedAuth(kind: string): AuthClient {
  const fail = (): never => {
    throw new AppSdkError(
      'AUTH_UNSUPPORTED',
      `当前数据驱动（${kind}）不支持应用用户体系；auth 需要平台数据服务（配置 CHATU_APP_KEY 使用 platform 驱动）`,
    )
  }
  return {
    async sendCode() { return fail() },
    async verifyCode() { return fail() },
    async register() { return fail() },
    async login() { return fail() },
    async getSession() { return fail() },
    async signOut() { return fail() },
    users: {
      async list() { return fail() },
      async get() { return fail() },
      async update() { return fail() },
      async delete() { return fail() },
    },
  }
}

let cached: { key: string; client: AuthClient } | null = null

/** 按当前配置取 auth 客户端（惰性、缓存；configure() 后自动重建） */
export function getAuth(): AuthClient {
  const cfg = resolveConfig()
  // memory 驱动带进程内状态：把 configure() 次数并入缓存键，重新配置即换一套干净的用户表
  const key = cfg.kind === 'platform' ? `platform|${cfg.baseUrl}|${cfg.env}|${cfg.apiKey.slice(-4)}` : `${cfg.kind}|${configVersion()}`
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client: cfg.kind === 'platform' ? platformAuth(cfg)
        : cfg.kind === 'memory' ? memoryAuth()
          : unsupportedAuth(cfg.kind),
    }
  }
  return cached.client
}

/** 便捷单例：`import { auth } from '@chatu-ai/app-sdk'` */
export const auth: AuthClient = {
  sendCode: (email) => getAuth().sendCode(email),
  verifyCode: (email, code, opts) => getAuth().verifyCode(email, code, opts),
  register: (email, password, opts) => getAuth().register(email, password, opts),
  login: (email, password) => getAuth().login(email, password),
  getSession: (token) => getAuth().getSession(token),
  signOut: (token) => getAuth().signOut(token),
  users: {
    list: (opts) => getAuth().users.list(opts),
    get: (id) => getAuth().users.get(id),
    update: (id, patch) => getAuth().users.update(id, patch),
    delete: (id) => getAuth().users.delete(id),
  },
}
