import { beforeEach, describe as d, expect, it } from 'vitest'
import { auth, configure, AppSdkError } from './index'

d('auth memory driver', () => {
  beforeEach(() => configure({ driver: 'memory' }))

  it('signs up on first code verify and keeps the same user on second login', async () => {
    const { devCode } = await auth.sendCode('Alice@Example.com ')
    expect(devCode).toMatch(/^\d{6}$/)
    const first = await auth.verifyCode('alice@example.com', devCode!, { name: '爱丽丝' })
    expect(first.created).toBe(true)
    expect(first.user.email).toBe('alice@example.com')
    expect(first.user.name).toBe('爱丽丝')
    expect(await auth.getSession(first.token)).toMatchObject({ id: first.user.id })

    const second = await auth.verifyCode('alice@example.com', (await auth.sendCode('alice@example.com')).devCode!)
    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
  })

  it('rejects a wrong code and consumes a used one', async () => {
    const { devCode } = await auth.sendCode('bob@example.com')
    await expect(auth.verifyCode('bob@example.com', '000000')).rejects.toThrow(AppSdkError)
    await auth.verifyCode('bob@example.com', devCode!)
    await expect(auth.verifyCode('bob@example.com', devCode!)).rejects.toThrow(/验证码/)
  })

  it('password register / login / duplicate email', async () => {
    const reg = await auth.register('carol@example.com', 'secret1', { name: 'Carol' })
    expect(reg.created).toBe(true)
    await expect(auth.register('carol@example.com', 'secret1')).rejects.toThrow(/已注册/)
    await expect(auth.register('dave@example.com', 'x')).rejects.toThrow(/6 位/)
    await expect(auth.login('carol@example.com', 'wrong')).rejects.toThrow(/不正确/)
    const login = await auth.login('carol@example.com', 'secret1')
    expect(login.user.id).toBe(reg.user.id)
  })

  it('never exposes the password and revokes sessions when disabled', async () => {
    const { token, user } = await auth.register('erin@example.com', 'secret1')
    expect((user as unknown as Record<string, unknown>).pwd).toBeUndefined()
    await auth.users.update(user.id, { disabled: true })
    expect(await auth.getSession(token)).toBeNull()
    await expect(auth.login('erin@example.com', 'secret1')).rejects.toThrow(/停用/)
  })

  it('lists, searches, updates and deletes users', async () => {
    const a = await auth.register('frank@example.com', 'secret1', { name: 'Frank' })
    await auth.register('grace@example.com', 'secret1', { name: 'Grace' })
    const list = await auth.users.list()
    expect(list.total).toBe(2)
    expect(list.users[0]!.email).toBe('grace@example.com') // 最新注册在前
    expect((await auth.users.list({ keyword: 'frank' })).total).toBe(1)
    expect((await auth.users.list({ limit: 1 })).nextSkip).toBe(1)

    const updated = await auth.users.update(a.user.id, { name: '弗兰克', meta: { role: 'admin' } })
    expect(updated.name).toBe('弗兰克')
    expect(updated.meta).toEqual({ role: 'admin' })
    expect(await auth.users.get(a.user.id)).toMatchObject({ name: '弗兰克' })

    expect(await auth.users.delete(a.user.id)).toBe(true)
    expect(await auth.users.get(a.user.id)).toBeNull()
    expect(await auth.getSession(a.token)).toBeNull()
  })

  it('getSession tolerates missing tokens', async () => {
    expect(await auth.getSession(null)).toBeNull()
    expect(await auth.getSession(undefined)).toBeNull()
    expect(await auth.signOut(null)).toBe(false)
  })
})

d('auth platform driver', () => {
  it('sends app key / env / session headers and unwraps responses', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const user = { id: 'u1', email: 'a@b.com', name: 'A', avatar: null, createdAt: 1, lastLoginAt: 2, disabled: false, meta: {} }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/auth/code/send')) return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 })
      if (url.endsWith('/auth/code/verify')) return new Response(JSON.stringify({ ok: true, token: 't1', user, created: true }), { status: 200 })
      if (url.includes('/auth/session')) return new Response(JSON.stringify({ ok: true, user }), { status: 200 })
      if (url.includes('/auth/users?')) return new Response(JSON.stringify({ ok: true, users: [user], total: 1, nextSkip: null }), { status: 200 })
      if (url.endsWith('/auth/users/u404')) return new Response(JSON.stringify({ ok: false, error: 'USER_NOT_FOUND' }), { status: 404 })
      return new Response(JSON.stringify({ ok: false, error: 'CODE_RATE_LIMITED', message: '发送过于频繁' }), { status: 429 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })

    expect(await auth.sendCode('a@b.com')).toEqual({ sent: true, devCode: null })
    const signed = await auth.verifyCode('a@b.com', '123456')
    expect(signed.token).toBe('t1')
    expect(await auth.getSession('t1')).toMatchObject({ id: 'u1' })
    expect((await auth.users.list({ keyword: 'a' })).total).toBe(1)
    expect(await auth.users.get('u404')).toBeNull()

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-conv-abc')
    expect(headers['x-chatu-env']).toBe('prod')
    const sessionCall = calls.find(c => c.url.includes('/auth/session'))!
    expect((sessionCall.init.headers as Record<string, string>)['x-app-session']).toBe('t1')

    await expect(auth.login('a@b.com', 'secret1')).rejects.toMatchObject({ code: 'CODE_RATE_LIMITED', status: 429 })
  })

  it('caches getSession to avoid paying for one auth call per request', async () => {
    let sessionCalls = 0
    const user = { id: 'u1', email: 'a@b.com', name: 'A', avatar: null, createdAt: 1, lastLoginAt: 2, disabled: false, meta: {} }
    const fetchImpl = (async (url: string) => {
      if (url.includes('/auth/session')) sessionCalls += 1
      if (url.includes('/auth/users/')) return new Response(JSON.stringify({ ok: true, user }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, user, removed: true }), { status: 200 })
    }) as unknown as typeof fetch

    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    await auth.getSession('t1')
    await auth.getSession('t1')
    await auth.getSession('t1')
    expect(sessionCalls).toBe(1)
    await auth.getSession('t2')
    expect(sessionCalls).toBe(2)

    // 停用某个用户后缓存必须作废，否则被停用的人还能继续访问
    await auth.users.update('u1', { disabled: true })
    await auth.getSession('t1')
    expect(sessionCalls).toBe(3)

    // 退出登录只清掉自己那条
    await auth.signOut('t1')
    await auth.getSession('t1')
    expect(sessionCalls).toBe(4)
    await auth.getSession('t2')
    expect(sessionCalls).toBe(5)

    // 显式关闭缓存：每次都回源
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl, authSessionCacheSeconds: 0 })
    sessionCalls = 0
    await auth.getSession('t1')
    await auth.getSession('t1')
    expect(sessionCalls).toBe(2)
  })

  it('refuses drivers without a platform data service', async () => {
    configure({ driver: 'edgeone' })
    await expect(auth.getSession('t')).rejects.toThrow(/不支持应用用户体系/)
  })
})

d('auth channel mode (渠道账号登录，技术方案 23)', () => {
  beforeEach(() => configure({ driver: 'memory', authMode: 'channel' }))

  it('用渠道裸账号登录，同一账号第二次登录复用同一用户', async () => {
    const first = await auth.login('zhangsan', '123456')
    expect(first.created).toBe(true)
    expect(first.user.username).toBe('zhangsan')
    expect(first.user.source).toBe('channel')
    expect(await auth.getSession(first.token)).toMatchObject({ id: first.user.id })

    const second = await auth.login('zhangsan', '123456')
    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
  })

  it('密码不对时拒绝登录', async () => {
    await expect(auth.login('zhangsan', 'wrong')).rejects.toThrow(/不正确/)
  })

  it('注册与验证码在渠道模式下明确不可用', async () => {
    await expect(auth.sendCode('a@b.com')).rejects.toThrow(/渠道账号模式/)
    await expect(auth.register('a@b.com', 'secret1')).rejects.toThrow(/渠道账号模式/)
  })

  it('停用后会话立即失效', async () => {
    const { token, user } = await auth.login('lisi', '123456')
    await auth.users.update(user.id, { disabled: true })
    expect(await auth.getSession(token)).toBeNull()
    await expect(auth.login('lisi', '123456')).rejects.toThrow(/停用/)
  })

  it('切回 app 模式后验证码登录恢复可用（配置变更会重建客户端）', async () => {
    configure({ driver: 'memory', authMode: 'app' })
    const { devCode } = await auth.sendCode('back@example.com')
    expect(devCode).toMatch(/^\d{6}$/)
  })
})
