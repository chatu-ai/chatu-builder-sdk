---
name: chatu-kv
description: 平台托管 KV 存储（@chatu-ai/app-sdk 的 kv）。当应用需要保存任何数据——待办、笔记、配置、计数器、用户提交的内容、列表数据——时使用。禁止引入 supabase/prisma/mongoose/mysql/redis 等外部数据库。
---

# KV 存储（kv）

平台托管的键值存储。**预览与线上是同一套 API**，数据都会持久保存（预览用 dev 命名空间，线上部署用 prod）。

## 何时用

- 任何需要"刷新页面后还在"的数据：待办、笔记、留言、配置、计数器、订单、用户资料…
- 不要用 `useState`/模块级变量/JSON 文件"假装持久化"——重启就丢；也不要引入外部数据库。

## API（只能在服务端调用）

```ts
import { kv } from '@/lib/platform';

await kv.set('todo:abc', { title: '买牛奶', done: false });   // 值是任意可 JSON 序列化的数据
await kv.set('code:123', 'x', { ex: 600 });                    // ex = 过期秒数
const todo = await kv.get<Todo>('todo:abc');                    // 不存在 → null
const many = await kv.mget<Todo>(['todo:a', 'todo:b']);         // 批量，缺失项为 null
const removed = await kv.del('todo:abc');                       // boolean
const n = await kv.incr('views');                               // 原子自增，返回新值；incr('views', 5) 加 5
await kv.expire('draft:1', 3600);                               // 给已有键设过期
const { keys, nextCursor } = await kv.list('todo:', { limit: 100 }); // 按前缀列键（分页游标）
```

## 标准写法：列表型数据用「前缀 + 逐条键」

**不要**把整个数组塞进一个键（并发写会互相覆盖、体积会爆）。用 `实体:id` 一条一个键：

```ts
// src/lib/todos.ts —— 服务端数据访问层
import { kv } from '@/lib/platform';

export interface Todo { id: string; title: string; done: boolean; createdAt: number }

export async function listTodos(): Promise<Todo[]> {
  const { keys } = await kv.list('todo:', { limit: 200 });
  const items = await kv.mget<Todo>(keys);
  return items.filter((t): t is Todo => !!t).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addTodo(title: string): Promise<Todo> {
  const todo: Todo = { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() };
  await kv.set(`todo:${todo.id}`, todo);
  return todo;
}

export async function toggleTodo(id: string): Promise<void> {
  const t = await kv.get<Todo>(`todo:${id}`);
  if (!t) return;
  await kv.set(`todo:${id}`, { ...t, done: !t.done });
}
```

在 Server Component 里直接 `await listTodos()` 渲染；在 Server Action 里改数据后 `revalidatePath('/')`：

```tsx
// src/app/page.tsx
import { listTodos, addTodo } from '@/lib/todos';
import { revalidatePath } from 'next/cache';

export default async function Home() {
  const todos = await listTodos();
  async function create(formData: FormData) {
    'use server';
    const title = String(formData.get('title') ?? '').trim();
    if (!title) return;
    await addTodo(title);
    revalidatePath('/');
  }
  return (<form action={create}>{/* … */}</form>);
}
```

浏览器组件（`'use client'`）不能直接 import `kv`——改成调用 Server Action，或 `fetch` 自己的 `src/app/api/*/route.ts`。

## 键名约定

- `实体:id`（`todo:uuid`）、`用户维度 用户:实体:id`（`u:${userId}:todo:${id}`），保证能用 `list(前缀)` 查出来。
- 键里不要放中文/空格；用 `crypto.randomUUID()` 或时间戳生成 id。

## 边界与禁忌

- **只在服务端**：Server Component / Server Action / Route Handler。前端 import 会直接报错或泄漏密钥。
- 单个值别超过几百 KB（大文件用 `storage`）。
- `list()` 是按前缀扫描，别在热路径上对上万条数据做全量 `list`+`mget`；分页展示时用 `limit` + `nextCursor`。
- 没有事务/多键原子操作；计数器用 `incr` 而不是 `get` 后 `set`。
- 不要引入 redis/ioredis 客户端——`kv` 已经是托管服务。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 刷新后数据没变 | Server Component 被缓存 | 改数据后 `revalidatePath()`；或页面加 `export const dynamic = "force-dynamic"` |
| `kv is not defined` / 打包报错 | 在 `'use client'` 组件里用了 | 移到 Server Action / Route Handler |
| 列表少数据 | `list()` 默认 100 条 | 传 `limit`，或用 `nextCursor` 翻页 |
