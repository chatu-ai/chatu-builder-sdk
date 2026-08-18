---
name: chatu-db
description: 平台托管文档集合（@chatu-ai/app-sdk 的 db）。当应用的数据是"一类记录的集合"——待办、文章、订单、评论、报名、库存、客户——需要按条件筛选、排序、分页、统计时使用。比 kv 更合适；仍禁止引入 supabase/prisma/mongoose/mysql 等外部数据库。
---

# 文档集合（db）

平台托管的文档数据库：一个集合 = 一类记录，每条记录是一个 JSON 文档。**预览（dev）与线上（prod）同一套 API**，数据都持久保存。

## 什么时候用 db，什么时候用 kv

| 场景 | 用 | 理由 |
| --- | --- | --- |
| 待办 / 文章 / 订单 / 评论 / 报名 …（一类记录，会列表展示） | **db** | 天生支持筛选、排序、分页、计数 |
| 单个配置、开关、计数器、验证码、临时缓存 | **kv**（见 `chatu-kv`） | 一个键一个值，最简单 |
| 文件本身（图片/附件） | **storage**（见 `chatu-storage`） | db 只存文件的 key 与元数据 |

## API（只能在服务端调用）

```ts
import { db } from '@/lib/platform';

interface Todo { title: string; done: boolean; priority?: number; tags?: string[] }
const todos = db.collection<Todo>('todos');           // 集合不存在会自动创建

const doc  = await todos.insert({ title: '买牛奶', done: false });   // 返回补好 _id/_createdAt/_updatedAt 的文档
const ids  = await todos.insertMany([{ title: 'a', done: false }, { title: 'b', done: false }]);
const one  = await todos.get(id);                       // 不存在 → null
const first= await todos.findOne({ done: false });      // 第一条匹配 → null
const { docs, total, nextSkip } = await todos.find({
  filter: { done: false, priority: { $gte: 2 } },
  sort: { _createdAt: -1 },                             // 1 升序 / -1 降序，可多字段
  skip: 0, limit: 20,                                   // limit ≤ 200，默认 50
});
const n = await todos.count({ done: true });
await todos.update(id, { set: { done: true }, inc: { views: 1 }, unset: ['draft'] });  // 局部更新
await todos.update(id, { set: { title: 'x' }, upsert: true });                          // 不存在则创建
await todos.replace(id, { title: '整体替换', done: false });
await todos.delete(id);
await todos.deleteMany({ done: true });
const list = await db.collections();                   // [{ name, count }]
```

每个文档自带 `_id`（字符串，时间有序）、`_createdAt`、`_updatedAt`（毫秒时间戳）。

## 过滤语法

```ts
{ done: false }                          // 等值
{ 'owner.name': '张三' }                  // 嵌套字段用点路径
{ priority: { $gt: 1, $lte: 5 } }         // $gt $gte $lt $lte
{ status: { $ne: 'archived' } }           // 不等
{ status: { $in: ['todo', 'doing'] } }    // 在集合内 / $nin 不在
{ title: { $contains: '牛奶' } }           // 字符串包含（忽略大小写）
{ tags: { $contains: '工作' } }            // 数组包含某元素
{ dueAt: { $exists: true } }              // 字段存在与否
{ $or: [{ done: true }, { priority: 3 }] } // $and / $or / $not 组合
```

## 标准写法：数据访问层 + Server Action

```ts
// src/lib/todos.ts
import { db } from '@/lib/platform';

export interface Todo { title: string; done: boolean; priority: number }
const todos = db.collection<Todo>('todos');

export async function listTodos(page = 0) {
  return todos.find({ sort: { _createdAt: -1 }, skip: page * 20, limit: 20 });
}
export async function addTodo(title: string) {
  return todos.insert({ title, done: false, priority: 2 });
}
export async function toggleTodo(id: string, done: boolean) {
  return todos.update(id, { set: { done } });
}
export async function removeTodo(id: string) {
  return todos.delete(id);
}
```

```tsx
// src/app/page.tsx
import { listTodos, addTodo, toggleTodo } from '@/lib/todos';
import { revalidatePath } from 'next/cache';

export default async function Home() {
  const { docs, total } = await listTodos();

  async function create(formData: FormData) {
    'use server';
    const title = String(formData.get('title') ?? '').trim();
    if (!title) return;
    await addTodo(title);
    revalidatePath('/');
  }
  async function toggle(formData: FormData) {
    'use server';
    await toggleTodo(String(formData.get('id')), formData.get('done') === '1');
    revalidatePath('/');
  }

  return (
    <main>
      <form action={create}>{/* input name="title" */}</form>
      <p>共 {total} 条</p>
      {docs.map((t) => (
        <form key={t._id} action={toggle}>
          <input type="hidden" name="id" value={t._id} />
          <input type="hidden" name="done" value={t.done ? '0' : '1'} />
          <button type="submit">{t.done ? '已完成' : '待办'} {t.title}</button>
        </form>
      ))}
    </main>
  );
}
```

浏览器组件（`'use client'`）不能 import `db`——通过 Server Action 或自己的 `src/app/api/*/route.ts` 间接调用。

## 分页

`find()` 返回 `total` 与 `nextSkip`（没有下一页时为 `null`）：

```ts
let skip = 0;
for (;;) {
  const page = await todos.find({ skip, limit: 100 });
  process(page.docs);
  if (page.nextSkip === null) break;
  skip = page.nextSkip;
}
```

## 边界与禁忌

- **只在服务端**调用；前端 import 会报错。
- 单文档 ≤ 256KB；单集合 ≤ 10,000 文档；单应用 ≤ 50 个集合；`limit` ≤ 200。数据量更大时按时间/用户拆分集合。
- 没有 join / 事务：关联数据存 id，分两次查；计数用 `update(id, { inc: { views: 1 } })`。
- 查询在服务端全量扫描后过滤，适合万级以内；别在渲染循环里对每条记录再查一次（N+1），先 `find` 一次再在内存里组装。
- 不要引入外部数据库/ORM，也不要用 `fs` 存 JSON 文件。
- 字段名不要以 `_` 开头（`_id`/`_createdAt`/`_updatedAt` 是平台保留字段，写入会被忽略/覆盖）。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 新增后页面没变 | Server Component 缓存 | Server Action 里 `revalidatePath()`；或页面 `export const dynamic = "force-dynamic"` |
| `update` 返回 null | 文档不存在 | 确认 id；需要"没有就创建"时传 `upsert: true` |
| 列表只有 50 条 | `limit` 默认 50 | 传 `limit`（≤200）并用 `nextSkip` 翻页 |
| 排序结果不对 | 字段类型混用（字符串与数字混存） | 统一字段类型；时间用毫秒时间戳数字 |
| `DOC_QUOTA_EXCEEDED` | 单集合超过 1 万条 | 归档旧数据（`deleteMany`）或按月/按用户拆集合 |
