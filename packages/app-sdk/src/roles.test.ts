import { afterEach, beforeEach, describe as d, expect, it } from 'vitest'
import { auth, configure } from './index'
import type { AppUser } from './index'

// 角色（技术方案 34 §3）：存 user.meta.roles，ADMIN_EMAILS 里的邮箱隐式 admin
const proc = (globalThis as any).process
const user = (over: Partial<AppUser> = {}): AppUser => ({
  id: 'u1', email: 'a@b.c', name: '张三', avatar: null, createdAt: 1, lastLoginAt: 1, disabled: false, meta: {}, ...over,
})

d('auth.roles', () => {
  beforeEach(() => { delete proc.env.ADMIN_EMAILS; configure({ driver: 'memory' }) })
  afterEach(() => { delete proc.env.ADMIN_EMAILS })

  it('of/has：读 meta.roles，未登录为空', () => {
    expect(auth.roles.of(null)).toEqual([])
    expect(auth.roles.of(user())).toEqual([])
    expect(auth.roles.of(user({ meta: { roles: ['admin', 'editor'] } }))).toEqual(['admin', 'editor'])
    expect(auth.roles.of(user({ meta: { roles: 'editor' } }))).toEqual(['editor'])
    expect(auth.roles.has(user({ meta: { roles: ['editor'] } }), 'admin', 'editor')).toBe(true)
    expect(auth.roles.has(user({ meta: { roles: ['editor'] } }), 'admin')).toBe(false)
    expect(auth.roles.has(null, 'admin')).toBe(false)
  })

  it('ADMIN_EMAILS 里的邮箱隐式 admin（大小写/空格不敏感），且不重复', () => {
    proc.env.ADMIN_EMAILS = ' A@B.C , boss@x.y '
    expect(auth.roles.of(user())).toEqual(['admin'])
    expect(auth.roles.of(user({ meta: { roles: ['admin'] } }))).toEqual(['admin'])
    expect(auth.roles.of(user({ email: 'other@x.y' }))).toEqual([])
    expect(auth.roles.has(user({ email: 'boss@x.y' }), 'admin')).toBe(true)
  })

  it('requireRole：没角色抛 FORBIDDEN(403)，有角色原样返回', () => {
    const admin = user({ meta: { roles: ['admin'] } })
    expect(auth.requireRole(admin, 'admin')).toBe(admin)
    expect(() => auth.requireRole(user(), 'admin')).toThrow(/admin/)
    try { auth.requireRole(null, 'admin') } catch (e: any) { expect(e.code).toBe('FORBIDDEN'); expect(e.status).toBe(403) }
  })

  it('grant/revoke：合并写回 meta，不丢原有字段', async () => {
    const { devCode } = await auth.sendCode('grant@x.y')
    const signed = await auth.verifyCode('grant@x.y', devCode!)
    const id = signed.user.id
    await auth.users.update(id, { meta: { nickname: '小明' } })
    const granted = await auth.roles.grant(id, 'editor', 'admin')
    expect(granted.meta).toMatchObject({ nickname: '小明', roles: ['editor', 'admin'] })
    const revoked = await auth.roles.revoke(id, 'admin')
    expect(revoked.meta.roles).toEqual(['editor'])
    expect(auth.roles.has(revoked, 'admin')).toBe(false)
    await expect(auth.roles.grant('nope', 'admin')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' })
  })
})
