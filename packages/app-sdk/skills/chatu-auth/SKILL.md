---
name: chatu-auth
description: 应用的登录用户体系（@chatu-ai/app-sdk 的 auth），两种模式：应用自建用户（邮箱验证码/密码，可自助注册；可加微信扫码、微信公众号 H5、GitHub 三方登录）或直接用渠道已有账号登录（不注册）。当应用需要"登录后才能用""每个人只看到自己的数据""会员/后台/多人协作""微信登录/GitHub 登录"时使用；含会话 Cookie、用户管理与三方登录的环境变量引导（```chatu-env 块）。禁止引入 next-auth/clerk/supabase-auth/firebase-auth/bcrypt/jose 等第三方登录库。
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
| 怎么登录 | 邮箱验证码 / 邮箱密码，可加微信 / GitHub 三方登录（见下方「三方登录」） | 渠道账号 + 密码（与登录渠道站点时一样） |
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

`AppUser`：`{ id, email, name, avatar, createdAt, lastLoginAt, disabled, meta }`（渠道账号 / 三方登录用户另有 `username` / `source`（`'channel' | 'wechat' | 'wechat-mp' | 'github'`），且 `email` 可能为 null）。密码永远不会回传。

**登录态存在 HttpOnly Cookie 里**，`signIn*` / `endSession` 会写/删 Cookie —— 因此**只能在 Server Action 或 Route Handler 中调用**（Server Component 只能 `currentUser()` 读）。

## 应用自建用户：登录页

邮箱验证码两步式（推荐，用户不用记密码）；也可以走邮箱 + 密码。**完整可复制的登录页与退出按钮代码见 [references/login-app.md](references/login-app.md)**，要点：

- 登录页是 Server Component + Server Action，`signIn*` / `endSession` 只能在 action 或 Route Handler 里调（要写 Cookie）；
- 发码按钮加 60 秒倒计时（服务端也有 60s 频控）；
- 已登录访问登录页要 `redirect('/')`。

## 三方登录（微信扫码 / 微信公众号 H5 / GitHub / Gitee / QQ）

只在**应用自建用户模式**下可用，是邮箱登录的补充（同一个用户体系，三方用户也在 `auth.users` 里，`source` 标记来源）。用户说"微信登录""GitHub 登录""Gitee 登录""QQ 登录""微信里打开自动登录"时用这一节；**完整登录页代码见 [references/login-oauth.md](references/login-oauth.md)**。

| provider | 场景 | 需要的环境变量 | 用户要准备什么 |
| --- | --- | --- | --- |
| `wechat` | PC 浏览器里弹二维码，微信扫码 | `WECHAT_APP_ID` `WECHAT_APP_SECRET` | 微信开放平台「网站应用」（企业主体，需审核） |
| `wechat-mp` | 在微信内打开应用（公众号菜单、聊天分享链接），网页授权登录 | `WECHAT_MP_APP_ID` `WECHAT_MP_APP_SECRET` | 已认证的**服务号**（订阅号没有网页授权） |
| `github` | GitHub 账号登录，开发者向工具 | `GITHUB_CLIENT_ID` `GITHUB_CLIENT_SECRET` | GitHub OAuth App（个人账号即可，无需审核） |
| `gitee` | Gitee（码云）账号登录，国内开发者向工具 | `GITEE_CLIENT_ID` `GITEE_CLIENT_SECRET` | Gitee「第三方应用」（个人账号即可，无需审核） |
| `qq` | QQ 账号登录，国内 C 端产品 | `QQ_APP_ID` `QQ_APP_KEY` | QQ 互联「网站应用」（个人可申请；需站点校验 + 人工审核，通常 1–3 个工作日） |

**怎么选微信**：用户说"微信登录"但没说场景时，问一句"主要在微信里打开，还是电脑浏览器扫码？"——微信内打开更常见，优先 `wechat-mp`；两者都要就两个都配，登录页按 `pickWeChatProvider()` 自动挑（微信内 → `wechat-mp`，否则 → `wechat`）。二者能否识别为同一人取决于用户是否在开放平台绑定了公众号（有 unionid 才合并），如实告知即可。

### 第一步：先要环境变量，再写代码

三方登录的密钥**由用户在 Builder 的「环境变量」面板里填**，你拿不到也不该拿到。流程固定为：

1. 看工作区 `.chatu/env-names.json`（`{ names: [...] }`，只有变量名没有值）判断需要的变量是否已存在。文件不存在 = 一个都没配。
2. 缺就**在回复正文里发一个 ```` ```chatu-env ```` 块**（Builder 会把它渲染成带「去哪个后台、填什么回调域、复制到哪」步骤的配置卡片，用户点"已配置，继续"后你才会收到后续消息）：

   ````md
   微信登录需要先在微信开放平台拿到应用凭据，配好后我再接入登录页：

   ```chatu-env
   { "preset": "wechat-mp", "vars": ["WECHAT_MP_APP_ID", "WECHAT_MP_APP_SECRET"], "resume": "已配置好微信公众号登录的环境变量，请继续" }
   ```
   ````

   字段：`preset`（`wechat` / `wechat-mp` / `github` / `gitee` / `qq`，卡片据此带出后台链接、回调域填写步骤，**必须填**，不要自己编步骤文案）、`vars`（变量名数组；也可写 `{ name, label, secret, required }` 对象）、`title`（可选）、`resume`（用户点"继续"时替他发出的那句话）。一个块只放一个 preset；同时要微信扫码 + 公众号就发两个块。
3. **发完块就停**，不要在同一轮继续写登录代码、不要在聊天里追问"AppID 是多少"、不要让用户把密钥贴在对话里。等用户回来（`resume` 那句话）再写代码。
4. 环境变量已存在时跳过 1–3 直接写代码；写完后**提醒用户回调域已由平台托管**（卡片里显示的域名，用户填到提供方后台即可），不需要在应用里再配任何回调地址。

### 第二步：接入登录页

发起与回调两条路由**模板已内置**，不要重写：

- `GET /api/auth/oauth/[provider]?returnTo=&mode=` —— 调 `oauthStartUrl()` 后 302 到提供方授权页；未配置时 302 回 `/login?error=OAUTH_NOT_CONFIGURED&missing=A,B`。
- `GET /api/auth/oauth/callback?ticket=&returnTo=` —— 调 `signInWithOAuthTicket()` 写 Cookie 后 302 回 `returnTo`；失败回 `/login?error=…`。

老工作区若没有 `src/app/api/auth/oauth/` 目录，按 references/login-oauth.md 末尾的两段代码补上。

登录页要做的只有两件事：

```ts
// 服务端（Server Component）：查哪些提供方已配置，决定显示哪些按钮
import { oauthProviders } from '@/lib/platform';
const { providers } = await oauthProviders();   // [{ provider, configured, missing }]

// 客户端按钮（'use client'）：必须在点击事件里同步调用
import { startOAuth, pickWeChatProvider } from '@chatu-ai/app-sdk/browser';
<button onClick={() => startOAuth('github', { returnTo: '/' })}>GitHub 登录</button>
<button onClick={() => startOAuth(pickWeChatProvider(), { returnTo: '/' })}>微信登录</button>
```

`startOAuth(provider, { returnTo?, mode? })`：`mode` 缺省 `auto`——在 Builder 预览（iframe）里自动用弹窗（提供方授权页禁止被嵌入），线上整页跳转；弹窗被拦截自动退化为跳转。`@chatu-ai/app-sdk/browser` 只有跳转与消息接收逻辑，不含密钥，**可以**在客户端组件里 import；`@/lib/platform` 仍然不能。

`oauthProviders()` 还返回 `callbackDomain` / `callbackUrl`（平台回调域），只用来给用户看，不要写死进代码。

### 三方登录的限制（要如实告诉用户）

- 公众号 H5 授权链接**只能在微信里打开**；PC 浏览器里点它会显示"请在微信客户端打开"。预览时用户要在微信里打开预览链接，或用扫码方式。微信内的预览要先在公众平台「网页开发者工具」绑定自己的微信号。
- 微信开放平台网站应用需要企业主体且审核通过，个人拿不到；用户是个人开发者时建议 GitHub / Gitee 或邮箱。
- QQ 互联网站应用审核通过前登录会报 `redirect uri is illegal`，且必须先把网站地址做站点校验（meta 标签或校验文件，卡片里有步骤）；用户要"马上能用"时先接 Gitee / GitHub，QQ 审核过了再补。
- QQ 只给昵称头像，没有邮箱；Gitee 的 `email` 也可能为 null（用户未公开）。
- 三方登录用户没有密码，`auth.users.update()` 改密码会报 `PASSWORD_NOT_ALLOWED`；`email` 可能为 null（微信不给邮箱），**用 `user.id` 做标识**。
- 渠道账号模式（`CHATU_AUTH_MODE=channel`）下三方登录不可用。

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
- 没有短信/手机号登录，也没有微信小程序、支付宝、Google 等其他三方；用户要"手机号登录"时如实说明当前只支持邮箱与微信 / GitHub / Gitee / QQ。不要自己去接任何提供方的 OAuth 接口（`api.weixin.qq.com` / `github.com/login/oauth` / `gitee.com/oauth` / `graph.qq.com`），平台已代做。
- 三方登录的密钥只能通过 ```` ```chatu-env ```` 块让用户在面板里配；不要写进代码、`.env` 或聊天。

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
| `OAUTH_NOT_CONFIGURED`（登录页 `?error=…&missing=A,B`） | 该提供方的环境变量没配或缺一个 | 发 ```` ```chatu-env ```` 块让用户配 `missing` 里的变量，不要在代码里绕 |
| `OAUTH_PROVIDER_UNKNOWN` | provider 拼错（只有 `wechat` / `wechat-mp` / `github` / `gitee` / `qq`） | 改 provider 名 |
| `OAUTH_CALLBACK_INVALID` / `OAUTH_CALLBACK_INSECURE` | 应用回调地址不合法（非 https、带 fragment 等） | 用模板的 `oauthStartUrl()`，它按当前 origin 拼回调，不要自己传 `callbackUrl` |
| `OAUTH_STATE_INVALID` / `OAUTH_TICKET_INVALID` | 授权超过 10 分钟 / ticket 超过 60 秒或被重复使用 | 让用户重新点登录；不要缓存或重放 ticket |
| `OAUTH_PROVIDER_DENIED` | 用户在授权页取消，或 code 已用过 | 登录页显示"已取消授权"，提供重试 |
| `OAUTH_EXCHANGE_FAILED` | 提供方接口不可达或返回错误（GitHub 国内偶发） | 提示稍后重试；不是密钥错误 |
| 微信页面提示"redirect_uri 参数错误" / "Scope 参数错误" | 用户在提供方后台填的回调域不对，或用了订阅号 / 未审核的网站应用 | 让用户按配置卡片重填回调域（只填域名）；确认是服务号 / 已审核 |
| `PASSWORD_NOT_ALLOWED` | 给三方登录用户设密码 | 三方用户没有密码，不要提供改密码入口 |
| 停用了用户但他还能访问 | 会话缓存最长 30 秒 | 等待缓存过期，或把 `CHATU_AUTH_SESSION_CACHE` 设为 0 |
| 别人能看到我的数据 | 查询没带 `userId`，或改删时没做归属校验 | 每个 find/update/delete 都带上 `userId` 判断 |
