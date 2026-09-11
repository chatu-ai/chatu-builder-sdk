---
name: chatu-admin
description: 后台管理页与角色权限（@chatu-ai/app-sdk 的 auth.roles / requireRole）。当应用要"只有管理员能看/能改"——后台、审核、用户管理、数据导出导入——或用户说"加个后台""给后台加个密""导出 Excel""把这些数据导进去"时使用。含第一个管理员怎么来（ADMIN_EMAILS + 环境变量卡片）、后台页守卫写法、CSV 导出导入。禁止自己写鉴权中间件、把角色判断放前端、或另装 next-auth/casbin 之类的权限库。
---

# 后台与角色权限（admin）

后台 = **登录**（`chatu-auth`）+ **角色**（本文）+ 一组只有管理员能进的页面。三者顺序固定，别跳步。

## 什么时候用

| 场景 | 做法 |
| --- | --- |
| 首轮做了 `/admin` 极简后台（`chatu-quickstart` 的默认动作），用户说"要加个密 / 只有我能看" | 本文全套：先接登录，再设管理员，再守卫 `/admin` |
| "要能审核 / 处理 / 改别人提交的数据" | 同上，处理动作放 Server Action，动作里再查一次角色 |
| "分角色：管理员、编辑、客服" | `auth.roles` 多角色；页面按角色显示不同入口 |
| "导出 Excel / 批量导入" | 读 `references/export-import.md` |
| 只是"我自己看的数据页"，没有其他用户 | **不需要后台**，别硬加登录 |

## 第一步：先有登录

后台要认人，所以应用必须先有 `chatu-auth` 的登录（邮箱验证码最省事，或用户已经要的微信/GitHub 登录）。已经有登录就跳过。

## 第二步：谁是管理员

角色存在用户的 `meta.roles` 里，另外**`ADMIN_EMAILS` 环境变量里的邮箱隐式拥有 `admin`**——第一个管理员就是这么来的，不用先在数据库里改一条记录。

工作区 `.chatu/env-names.json` 里没有 `ADMIN_EMAILS` 就发一个 ```` ```chatu-env ```` 块并**停下**等用户配置：

````md
后台我做好了，先把你自己设成管理员：

```chatu-env
{ "preset": "admin", "vars": ["ADMIN_EMAILS"], "resume": "管理员邮箱配好了，请继续" }
```
````

提醒用户：填的是**登录这个应用**用的邮箱（不是 ChatU 平台账号），而且要用这个邮箱在应用里登录过一次。

## 第三步：角色 API

```ts
import { auth, currentUser } from '@/lib/platform';

auth.roles.of(user)                       // string[]，含 ADMIN_EMAILS 带来的 admin
auth.roles.has(user, 'admin', 'editor')   // 任一命中即 true；纯判断，不发请求
auth.requireRole(user, 'admin')           // 不满足抛 FORBIDDEN(403)，满足则原样返回 user
await auth.roles.grant(userId, 'editor'); // 加角色（合并写回 meta.roles）
await auth.roles.revoke(userId, 'editor');
```

`ADMIN_EMAILS` 带来的 `admin` 是"配置给的"，`revoke` 去不掉——要改就改环境变量。

## 第四步：守卫后台页

**一处守卫，整个 `/admin` 生效**：

```tsx
// src/app/admin/layout.tsx
import { redirect } from 'next/navigation';
import { auth, requireUser } from '@/lib/platform';

export const dynamic = 'force-dynamic';   // 后台永远不要静态化

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('/login?returnTo=/admin');   // 未登录 → 登录页
  if (!auth.roles.has(user, 'admin')) redirect('/');          // 登录了但不是管理员 → 首页
  return <div className="mx-auto max-w-6xl p-6">{children}</div>;
}
```

**每个写操作再查一次**——布局守的是页面，Server Action 是独立入口，能被直接调用：

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { auth, currentUser, db } from '@/lib/platform';

export async function approve(id: string) {
  const user = await currentUser();
  if (!auth.roles.has(user, 'admin')) return { error: '没有权限' };   // 给页面用：返回错误而不是抛
  await db.collection('applications').update(id, { set: { status: 'approved', approvedBy: user!.id } });
  revalidatePath('/admin/applications');
  return { ok: true };
}
```

Route Handler 里用 `requireRole` 更直接：

```ts
export async function GET() {
  try { auth.requireRole(await currentUser(), 'admin'); }
  catch { return Response.json({ error: 'forbidden' }, { status: 403 }); }
  // …
}
```

## 用户管理页（要分角色时才做）

```tsx
const { users } = await auth.users.list({ limit: 50 });
// 表格列：邮箱 / 名字 / 注册时间 / 角色（auth.roles.of(u).join(', ') || '普通用户'）/ 操作
```

- 授权/取消授权放 Server Action：`await auth.roles.grant(id, 'editor')` 后 `revalidatePath`。
- **不要让管理员把自己的 admin 撤掉**（撤了就进不去了）：`if (id === me.id) return { error: '不能修改自己的角色' }`。
- `auth.users.list` 按页返回，搜索用 `keyword`，别一次拉全部。

## 导出 / 导入

见 `references/export-import.md`（`toCsv` / `parseCsv`、分页取完、导入先 zod 校验再 `insertMany`、失败行报行号）。

## 边界与禁忌

- **不要自己写 middleware 做鉴权**：Next 的 middleware 在边缘运行时里拿不到平台会话，守卫写在 `layout.tsx` + 每个动作里。
- **不要把角色判断只放前端**（隐藏按钮不等于没权限）；页面能藏，动作必须再判一次。
- 不要装 next-auth / casbin / accesscontrol 之类的库——角色就是 `meta.roles` 一个数组。
- 不要把 `ADMIN_EMAILS` 写死在代码里，也不要在代码里判断"某个固定邮箱"；它是环境变量。
- 后台页一律 `export const dynamic = 'force-dynamic'`，否则会看到缓存的旧数据。
- 后台只给管理员看，但**数据本身仍然是应用数据**：别在后台里展示密钥、token、其他应用的数据。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 配了 `ADMIN_EMAILS` 还是进不去 | 用的登录邮箱和填的不一致，或还没用这个邮箱登录过 | 让用户核对邮箱、重新登录一次；`auth.roles.of(user)` 打印出来看 |
| 登录页转圈/循环跳转 | layout 里 `redirect('/login')` 而登录页也在 `/admin` 布局下 | 登录页放在 `/admin` 之外 |
| 普通用户直接调 Server Action 改了数据 | 只在页面做了判断 | 每个 Action 开头再查一次角色 |
| `FORBIDDEN` 抛到页面变成 500 | 在 Server Action / 页面里用了 `requireRole` 却没接住 | 页面用 `roles.has` 返回提示；Route Handler 里 try/catch 转 403 |
| 授权后页面还是旧角色 | 没有 `revalidatePath`，或会话缓存 | 动作后 `revalidatePath`；用户重新进页面即可，不必重新登录 |
