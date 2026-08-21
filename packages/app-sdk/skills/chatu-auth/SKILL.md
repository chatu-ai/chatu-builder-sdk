---
name: chatu-auth
description: 应用自己的登录用户体系（@chatu-ai/app-sdk 的 auth）。当应用需要"登录后才能用""每个人只看到自己的数据""会员/后台/多人协作"时使用；提供邮箱验证码登录、邮箱密码登录、会话 Cookie、用户管理。禁止引入 next-auth/clerk/supabase-auth/firebase-auth/bcrypt/jose 等第三方登录库。
---

# 应用用户体系（auth）

给**生成出来的这个应用**一套自己的终端用户：注册、登录、会话、退出、用户管理。与 ChatU 平台账号完全无关，数据按"应用 + 环境（预览/线上）"隔离——预览环境注册的测试账号不会出现在线上。

## 什么时候需要它

| 需求 | 是否需要 auth |
| --- | --- |
| "我的待办/我的收藏/我的订单"——每人只看自己的数据 | ✅ |
| 会员中心、后台管理页、只有登录用户能发帖/评论 | ✅ |
| 多人协作（谁创建的、谁修改的） | ✅ |
| 纯展示页、工具页、所有人看到同样内容 | ❌ 不要加登录，直接做 |

## API

```ts
import {
  currentUser, requireUser, sendLoginCode, signInWithCode,
  signUpWithPassword, signInWithPassword, endSession, auth,
} from '@/lib/platform';

const user = await currentUser();          // AppUser | null，Server Component 里可直接用
const me   = await requireUser();          // 未登录自动 redirect('/login')

// 邮箱验证码（推荐：不用记密码）
const { devCode } = await sendLoginCode(email);   // 预览环境未配邮件时返回 devCode，方便自测
const user = await signInWithCode(email, code, { name });  // 首次登录自动注册

// 邮箱 + 密码（可选路线）
await signUpWithPassword(email, password, { name });       // 密码 ≥ 6 位
await signInWithPassword(email, password);

await endSession();                        // 退出登录

// 用户管理（后台页用）
const { users, total, nextSkip } = await auth.users.list({ skip: 0, limit: 50, keyword: '张' });
await auth.users.update(id, { name: '新名字', disabled: true, meta: { role: 'admin' } });
await auth.users.delete(id);
```

`AppUser`：`{ id, email, name, avatar, createdAt, lastLoginAt, disabled, meta }`。密码永远不会回传。

**登录态存在 HttpOnly Cookie 里**，`signIn*` / `endSession` 会写/删 Cookie —— 因此**只能在 Server Action 或 Route Handler 中调用**（Server Component 只能 `currentUser()` 读）。

## 标准登录页（验证码，两步）

```tsx
// src/app/login/page.tsx
import { redirect } from 'next/navigation';
import { sendLoginCode, signInWithCode, currentUser } from '@/lib/platform';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ email?: string; error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { email, error } = await searchParams;

  async function send(formData: FormData) {
    'use server';
    const value = String(formData.get('email') ?? '').trim();
    if (!value) return;
    await sendLoginCode(value);
    redirect(`/login?email=${encodeURIComponent(value)}`);
  }

  async function verify(formData: FormData) {
    'use server';
    try {
      await signInWithCode(String(formData.get('email')), String(formData.get('code')));
    } catch {
      redirect(`/login?email=${encodeURIComponent(String(formData.get('email')))}&error=1`);
    }
    redirect('/');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      {!email ? (
        <form action={send} className="space-y-3">
          <input name="email" type="email" required placeholder="邮箱" className="w-full rounded-md border px-3 py-2" />
          <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">发送验证码</button>
        </form>
      ) : (
        <form action={verify} className="space-y-3">
          <input type="hidden" name="email" value={email} />
          <p className="text-sm text-muted-foreground">验证码已发送至 {email}</p>
          {error ? <p className="text-sm text-destructive">验证码不正确或已过期</p> : null}
          <input name="code" inputMode="numeric" required placeholder="6 位验证码" className="w-full rounded-md border px-3 py-2" />
          <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">登录</button>
        </form>
      )}
    </main>
  );
}
```

退出登录：

```tsx
import { endSession } from '@/lib/platform';
import { redirect } from 'next/navigation';

export function SignOutButton() {
  async function out() {
    'use server';
    await endSession();
    redirect('/login');
  }
  return <form action={out}><button className="text-sm underline">退出登录</button></form>;
}
```

## 每个用户自己的数据

约定：在 db 文档里存 `userId`，**每次查询都带上它**（见 `chatu-db`）。

```ts
// src/lib/todos.ts
import { db, requireUser } from '@/lib/platform';

interface Todo { userId: string; title: string; done: boolean }
const todos = db.collection<Todo>('todos');

export async function myTodos() {
  const me = await requireUser();
  return todos.find({ filter: { userId: me.id }, sort: { _createdAt: -1 }, limit: 100 });
}

export async function addTodo(title: string) {
  const me = await requireUser();
  return todos.insert({ userId: me.id, title, done: false });
}

export async function toggleTodo(id: string, done: boolean) {
  const me = await requireUser();
  const doc = await todos.get(id);
  if (!doc || doc.userId !== me.id) throw new Error('无权操作');   // 越权检查不能省
  return todos.update(id, { set: { done } });
}
```

管理员：用 `meta.role === 'admin'` 判断（在平台「用户」面板或后台页给某个用户打上），不要硬编码邮箱白名单以外的复杂权限模型。

## 边界与禁忌

- **禁止**引入 next-auth / auth.js / clerk / supabase-auth / firebase-auth / passport / bcrypt / jose / jsonwebtoken —— 平台已提供，装了也跑不通（沙箱与函数部署都没有对应后端）。
- 不要自己生成 JWT、不要把用户信息写进普通 Cookie / localStorage，会话只用 `chatu_session`（HttpOnly）。
- 不要在客户端组件里 import `@/lib/platform` 的 auth；通过 Server Action 或 Route Handler 拿 `currentUser()` 的结果传下去。
- 需要登录的页面要么 `await requireUser()`，要么在 Server Action 里再校验一次——只在前端隐藏按钮不算保护。
- 单应用单环境上限 1 万用户、每日验证码 200 封；验证码 10 分钟有效、错 5 次作废、同一邮箱 60 秒才能再发一次。
- 只有邮箱登录；没有短信、没有微信/GitHub 第三方登录。用户要"手机号登录"时，如实说明当前只支持邮箱。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `Cookies can only be modified in a Server Action or Route Handler` | 在 Server Component 里调用了 `signIn*` / `endSession` | 挪进 `'use server'` 的 action 或 `route.ts` |
| 登录后刷新又变未登录 | 页面被静态预渲染 | 保留 layout 里的 `export const dynamic = "force-dynamic"` |
| `EMAIL_NOT_CONFIGURED`（线上） | 平台未配置邮件通道 | 线上改用邮箱密码登录，或让用户联系平台开通 |
| `CODE_RATE_LIMITED` | 同一邮箱 60 秒内重复发码 | 前端按钮加倒计时 |
| `AUTH_UNSUPPORTED` | 应用被部署在没有平台数据服务的驱动上（如 edgeone blob） | 部署时选择带平台数据服务的目标 |
| 别人能看到我的数据 | 查询没带 `userId`，或改删时没做归属校验 | 每个 find/update/delete 都带上 `userId` 判断 |
