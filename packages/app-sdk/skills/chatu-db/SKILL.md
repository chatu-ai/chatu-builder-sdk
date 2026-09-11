---
name: chatu-db
description: 平台托管文档集合（@chatu-ai/app-sdk 的 db）。当应用的数据是"一类记录的集合"——待办、文章、订单、评论、报名、库存、客户——需要按条件筛选、排序、分页、统计时使用。比 kv 更合适；仍禁止引入 supabase/prisma/mongoose/mysql 等外部数据库。用户明确要求"用 SQLite / 数据放自己服务器 / 不用平台数据库"时，按本文「平台托管还是本地 SQLite」一节处理（先讲缺点，不主动推荐）。
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
- 需要「按语义找相似内容」（知识库问答、相似推荐）时，把向量存进文档的 `embedding` 字段用 `vectorSearch` 检索——见 `chatu-ai` 的 `references/rag.md`；别自己写全表遍历算相似度。

## 平台托管还是本地 SQLite

**默认且推荐：平台托管**——预览/线上两套数据、发布面板可看可复制、一键部署自动带上、有配额保护。**不要主动提"可以换 SQLite"**，不要把它当成省钱/更快/更简单的选项去介绍。

只有用户**自己明确说**"用 SQLite""数据要放我自己服务器/本地""不想用你们的数据库/不想计费"时才走下面的流程：

1. **先把缺点讲清楚，再动手**。可以直接复述这段：

   > 可以改用本地 SQLite（数据库和 KV 存到应用目录下的一个文件），代码不用改。但要先说明几点：① **不能一键部署到 EdgeOne Pages 和云函数**——它们没有持久磁盘，只能用 Docker、你自己的服务器或本机运行；② **数据跟着文件走**——预览期的数据在沙箱的 `data/` 目录里，不进 Git、不进导出 ZIP、不进部署产物，没有 dev→prod 数据复制和发布面板的数据浏览，备份迁移要自己做，删除会话后数据就没了；③ **登录、文件存储、AI 仍然依赖平台**，导出后要另配 `CHATU_DATA_URL` / `CHATU_APP_KEY`；④ **单机单实例**，写性能一般，只适合几万条以内的小数据。确认要换吗？

2. 用户确认后，在回复正文里发一个 ```` ```chatu-env ```` 块（Builder 渲染成配置卡片，用户填好点"继续"后你才会收到后续消息），**发完块就停**：

   ````md
   ```chatu-env
   { "preset": "sqlite", "vars": ["CHATU_DATA_DRIVER"], "resume": "已改成本地 SQLite，请继续" }
   ```
   ````

3. 用户回来后**代码一行不用改**：`db` / `kv` 的 API 与语义完全相同（换驱动 = 一个环境变量）。检查 `.chatu/env-names.json` 里有 `CHATU_DATA_DRIVER` 即视为已切换。
4. 之后用户要发布时，只能走「导出 ZIP」（Docker，`DEPLOY.md` 有 SQLite 一节）或「推送到 Git 仓库」；选 EdgeOne / 云函数时要提醒他线上不会用 SQLite（见 `chatu-deploy`）。用户想改回平台托管：让他在「环境变量」面板删掉 `CHATU_DATA_DRIVER`。

禁止：`import 'node:sqlite'`、装 `better-sqlite3` / `sqlite3` / `sql.js`、自己写 SQL、直接读写 `data/*.sqlite` 文件——一律通过 `db` / `kv`，否则应用就回不到平台托管了。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 新增后页面没变 | Server Component 缓存 | Server Action 里 `revalidatePath()`；或页面 `export const dynamic = "force-dynamic"` |
| `update` 返回 null | 文档不存在 | 确认 id；需要"没有就创建"时传 `upsert: true` |
| 列表只有 50 条 | `limit` 默认 50 | 传 `limit`（≤200）并用 `nextSkip` 翻页 |
| 排序结果不对 | 字段类型混用（字符串与数字混存） | 统一字段类型；时间用毫秒时间戳数字 |
| `DOC_QUOTA_EXCEEDED` | 单集合超过 1 万条 | 归档旧数据（`deleteMany`）或按月/按用户拆集合 |
| `SQLITE_UNAVAILABLE` | 配了 `CHATU_DATA_DRIVER=sqlite` 但运行环境 Node < 22.13 | 升级 Node，或删掉该变量改回平台托管 |
