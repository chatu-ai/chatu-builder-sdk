---
name: chatu-validation
description: 用 zod 校验一切来自外部的输入（Server Action 的 FormData、Route Handler 的 JSON body、URL 查询参数、AI 返回的 JSON、第三方接口响应）。当你要写表单提交、API 路由、参数解析或让 AI 输出结构化数据时使用。禁止直接 `as string` / `as any` 把外部输入当成可信数据。
---

# 输入校验（zod）

模板已预装 `zod`。**凡是从外面来的数据都要先校验再用**——这是线上 500 最常见的来源：`FormData.get()` 返回 `File | string | null`，查询参数永远是字符串，AI 返回的 JSON 字段可能缺失或类型不对。

## 铁律

```ts
// ❌ 会在线上炸：值可能是 null / File / 空字符串
const title = formData.get('title') as string;
const page = Number(searchParams.page);        // NaN
const data = await res.json() as Todo[];       // 类型是编的

// ✅ 先校验，拿到的就是可信数据
const { title } = TodoInput.parse(Object.fromEntries(formData));
```

## Server Action：表单提交

```ts
// src/lib/schemas.ts
import { z } from 'zod';

export const TodoInput = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100, '标题最多 100 字'),
  priority: z.coerce.number().int().min(1).max(3).default(2),   // 表单值是字符串 → coerce
  dueAt: z.coerce.date().optional(),
  done: z.union([z.literal('on'), z.literal('')]).transform(v => v === 'on').optional(),  // checkbox
});
export type TodoInput = z.infer<typeof TodoInput>;
```

```tsx
// src/app/page.tsx
'use server' 的 action 里用 safeParse，把错误回给页面而不是抛 500：

async function create(formData: FormData) {
  'use server';
  const parsed = TodoInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    // 用 useActionState 时 return { error }；简单页面可以 redirect 带 ?error=
    return { error: parsed.error.issues[0]?.message ?? '输入不合法' };
  }
  await addTodo(parsed.data);
  revalidatePath('/');
  return { ok: true };
}
```

## Route Handler：JSON body 与查询参数

```ts
// src/app/api/todos/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';

const Query = z.object({
  page: z.coerce.number().int().min(0).default(0),
  keyword: z.string().trim().max(50).optional(),
});

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  // parsed.data.page 一定是数字
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);        // 请求体可能不是 JSON
  const parsed = TodoInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
}
```

## AI 返回的 JSON（配合 `ai.json`）

```ts
import { ai } from '@/lib/platform';
import { z } from 'zod';

const Extracted = z.object({
  title: z.string(),
  amount: z.number(),
  tags: z.array(z.string()).max(5).default([]),
});

const data = await ai.json('从这段文字里抽取标题、金额、标签：' + text, {
  schema: z.toJSONSchema(Extracted),     // 让模型知道该回什么（zod v4）
  validate: v => Extracted.parse(v),      // 不合格会自动带着错误重试一次
});
// data 已经是 { title: string; amount: number; tags: string[] }
```

`ai.json` 会：强制只回 JSON → 剥掉代码围栏 → 解析 → 跑 `validate` → 不合格就把错误发回模型重试（默认 1 次）。详见 `chatu-ai`。

## 常用写法速查

| 场景 | 写法 |
| --- | --- |
| 表单里的数字/日期 | `z.coerce.number()` / `z.coerce.date()` |
| 可选但不能是空串 | `z.string().trim().min(1).optional()` |
| 枚举 | `z.enum(['todo', 'doing', 'done'])` |
| 邮箱 / URL | `z.email()` / `z.url()` |
| 数组上限（防刷） | `z.array(Item).max(100)` |
| 只读用户输入的一部分 | `Schema.pick({ title: true })` |
| 更新接口（全部可选） | `Schema.partial()` |

## 边界与禁忌

- **不要**把 zod schema 放进 `'use client'` 组件再 import 服务端逻辑；schema 本身可以共享（纯数据），数据库调用不行。
- 校验失败要**返回可读中文提示**（取 `issues[0].message`），不要把整个 zod 错误对象丢给用户。
- 服务端永远重新校验一次：前端的 `required`/`pattern` 只是体验，不是安全边界。
- 涉及"谁的数据"时，校验之外还要做归属检查（见 `chatu-auth` 的越权检查）。
- 不要为了通过校验而 `z.any()`；宁可先窄后宽。
