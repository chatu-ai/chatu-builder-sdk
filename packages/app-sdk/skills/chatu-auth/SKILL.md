---
name: chatu-auth
description: 应用的登录用户体系（@chatu-ai/app-sdk 的 auth），两种模式：应用自建用户（邮箱验证码/密码，可自助注册）或直接用渠道已有账号登录（不注册）。当应用需要"登录后才能用""每个人只看到自己的数据""会员/后台/多人协作"时使用；含会话 Cookie 与用户管理。禁止引入 next-auth/clerk/supabase-auth/firebase-auth/bcrypt/jose 等第三方登录库。
---

# 应用用户体系（auth）

给**生成出来的这个应用**一套自己的终端用户：注册、登录、会话、退出、用户管理。**用量计入应用所有者的 ChatU 点数**（每次调用记 `auth_ops`，实际外发的验证码邮件另按封计价，见下方「计费与省钱写法」）。与 ChatU 平台账号完全无关，数据按"应用 + 环境（预览/线上）"隔离——预览环境注册的测试账号不会出现在线上。

## 什么时候需要它

| 需求 | 是否需要 auth |
| --- | --- |
| "我的待办/我的收藏/我的订单"——每人只看自己的数据 | ✅ |
| 会员中心、后台管理页、只有登录用户能发帖/评论 | ✅ |
| 多人协作（谁创建的、谁修改的） | ✅ |
| 纯展示页、工具页、所有人看到同样内容 | ❌ 不要加登录，直接做 |

## 两种模式：先问用户，不要替他选

| | **应用自建用户**（默认） | **渠道账号** |
| --- | --- | --- |
| 用户是谁 | 任何访客，自己注册 | 应用所属渠道里已有的账号 |
| 怎么登录 | 邮箱验证码 / 邮箱密码 | 渠道账号 + 密码（与登录渠道站点时一样） |
| 能注册吗 | ✅ 首次登录自动注册 | ❌ 账号由渠道侧开通，应用内不提供注册 |
| 忘记密码 | 改用邮箱验证码登录 | 去渠道站点重置，应用管不了 |
| 适合 | 面向公众的产品、会员站 | 面向渠道内部既有用户的工具/后台 |

**用户说"要登录"时，先问一句再动手**，例如：

> 登录用哪种账号？① 让访客用邮箱自行注册登录；② 用你们渠道现有的账号直接登录（不开放注册）。

模式由平台的环境变量 `CHATU_AUTH_MODE` 决定（`app` 默认 / `channel`），**你不要自己改它**——告诉用户选了哪种，由平台侧配置。写代码时按下面对应的那一节写。**一个应用只用一种模式。**

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
await signInWithPassword(account, password);   // app 模式传邮箱；channel 模式传渠道账号

await endSession();                        // 退出登录

// 用户管理（后台页用）
const { users, total, nextSkip } = await auth.users.list({ skip: 0, limit: 50, keyword: '张' });
await auth.users.update(id, { name: '新名字', disabled: true, meta: { role: 'admin' } });
await auth.users.delete(id);
```

`AppUser`：`{ id, email, name, avatar, createdAt, lastLoginAt, disabled, meta }`（渠道账号模式另有 `username` / `source`，且 `email` 可能为 null）。密码永远不会回传。

**登录态存在 HttpOnly Cookie 里**，`signIn*` / `endSession` 会写/删 Cookie —— 因此**只能在 Server Action 或 Route Handler 中调用**（Server Component 只能 `currentUser()` 读）。

## 应用自建用户：登录页

邮箱验证码两步式（推荐，用户不用记密码）；也可以走邮箱 + 密码。**完整可复制的登录页与退出按钮代码见 [references/login-app.md](references/login-app.md)**，要点：

- 登录页是 Server Component + Server Action，`signIn*` / `endSession` 只能在 action 或 Route Handler 里调（要写 Cookie）；
- 发码按钮加 60 秒倒计时（服务端也有 60s 频控）；
- 已登录访问登录页要 `redirect('/')`。


## 渠道账号模式：登录页与差异

登录页只有**账号 + 密码**一步，没有注册入口、没有验证码。**完整代码见 [references/login-channel.md](references/login-channel.md)**。

与自建用户模式的差异：

| | 渠道账号模式 |
| --- | --- |
| 可用 | `currentUser()` / `requireUser()` / `signInWithPassword(账号, 密码)` / `endSession()` / `auth.users.list()` |
| 不可用（会抛 `AUTH_MODE_UNSUPPORTED`） | `sendLoginCode()` / `signInWithCode()` / `signUpWithPassword()` |
| 用户字段 | 多出 `username`（渠道账号名）与 `source: 'channel'`；`email` 取决于渠道资料，**可能为 null** |
| 用户管理 | 只能看 + 在**本应用范围内**停用（不影响渠道账号本身）；不能改资料、不能删渠道账号 |

**别做的事**：不要在登录页放"注册"按钮或"忘记密码"表单（应用没有这两个能力）；不要在代码里给账号拼 `渠道ID.` 前缀（服务端会拼）；不要因为 `email` 可能为空就用它当用户标识——**用 `user.id`**。

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

## 计费与省钱写法

| 计量项 | 何时累加 | 默认折算 |
| --- | --- | --- |
| `auth_ops` | 每次 auth 接口调用（发码、校验、登录、`currentUser()`、用户管理…） | 100 次 = 1 点 |
| `auth_emails` | **真正发出**的验证码邮件（预览环境未配邮件返回 devCode 时不计） | 1 封 = 1 点 |

`currentUser()` / `requireUser()` 每次请求都会打一次会话校验，是最容易放量的一项。SDK 已内置 **30 秒进程内会话缓存**（`CHATU_AUTH_SESSION_CACHE` 秒数可调，0 关闭），但代码写法仍决定实际调用量：

```ts
// ✅ 一个页面/一次 Server Action 只取一次，往下传
export default async function Page() {
  const me = await requireUser();
  return <><Header user={me} /><TodoList user={me} /></>;   // 不要在每个子组件里再 currentUser()
}

// ❌ 循环里逐条校验
for (const item of items) { const me = await currentUser(); /* … */ }

// ✅ 公开页面不要强行登录：能匿名浏览的内容别加 requireUser()
```

发码按钮务必加 60 秒倒计时（服务端也有 60s 频控），既省邮件钱也避免 `CODE_RATE_LIMITED`。批量导入用户时用 `auth.users.list({ limit: 200 })` 一次多取，别逐个 `users.get()`。

## 边界与禁忌

- **禁止**引入 next-auth / auth.js / clerk / supabase-auth / firebase-auth / passport / bcrypt / jose / jsonwebtoken —— 平台已提供，装了也跑不通（沙箱与函数部署都没有对应后端）。
- 不要自己生成 JWT、不要把用户信息写进普通 Cookie / localStorage，会话只用 `chatu_session`（HttpOnly）。
- 不要在客户端组件里 import `@/lib/platform` 的 auth；通过 Server Action 或 Route Handler 拿 `currentUser()` 的结果传下去。
- 需要登录的页面要么 `await requireUser()`，要么在 Server Action 里再校验一次——只在前端隐藏按钮不算保护。
- 单应用单环境上限 1 万用户、每日验证码 200 封（超出报 `CODE_QUOTA_EXCEEDED`）、每日新注册 500 个（`SIGNUP_QUOTA_EXCEEDED`）；验证码 10 分钟有效、错 5 次作废、同一邮箱 60 秒才能再发一次。
- 密码登录同一邮箱连续失败 10 次会锁 15 分钟（`TOO_MANY_ATTEMPTS`）——登录页要把这个错误如实告诉用户，并提示"可以改用邮箱验证码登录"。
- 只有邮箱登录；没有短信、没有微信/GitHub 第三方登录。用户要"手机号登录"时，如实说明当前只支持邮箱。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `Cookies can only be modified in a Server Action or Route Handler` | 在 Server Component 里调用了 `signIn*` / `endSession` | 挪进 `'use server'` 的 action 或 `route.ts` |
| 登录后刷新又变未登录 | 页面被静态预渲染 | 保留 layout 里的 `export const dynamic = "force-dynamic"` |
| `EMAIL_NOT_CONFIGURED`（线上） | 平台未配置邮件通道 | 线上改用邮箱密码登录，或让用户联系平台开通 |
| `CODE_RATE_LIMITED` | 同一邮箱 60 秒内重复发码 | 前端按钮加倒计时 |
| `TOO_MANY_ATTEMPTS` | 密码连续输错 10 次，已锁定 15 分钟 | 提示改用验证码登录，或等锁定过期 |
| `SIGNUP_QUOTA_EXCEEDED` | 当日新注册超过 500 | 正常应用不会触发；若被刷可在平台「用户」面板停用异常账号 |
| `AUTH_MODE_UNSUPPORTED` | 渠道账号模式下调了注册/验证码接口 | 渠道模式没有注册；登录用 `signInWithPassword(账号, 密码)` |
| `CHANNEL_AUTH_NOT_CONFIGURED` | 平台未给该渠道配好登录参数 | 应用侧解决不了，如实告知用户联系平台开通 |
| `CHANNEL_AUTH_UNAVAILABLE` | 渠道登录服务暂时不可达 | 提示用户稍后重试，不要把它当成"密码错误"显示 |
| `AUTH_UNSUPPORTED` | 应用被部署在没有平台数据服务的驱动上（如 edgeone blob） | 部署时选择带平台数据服务的目标 |
| `READ_ONLY` / 无法注册新用户 | 应用所有者点数不足，数据已置只读 | 已登录用户仍可访问；充值后自动恢复 |
| 停用了用户但他还能访问 | 会话缓存最长 30 秒 | 等待缓存过期，或把 `CHATU_AUTH_SESSION_CACHE` 设为 0 |
| 别人能看到我的数据 | 查询没带 `userId`，或改删时没做归属校验 | 每个 find/update/delete 都带上 `userId` 判断 |
