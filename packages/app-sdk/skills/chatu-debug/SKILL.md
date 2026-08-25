---
name: chatu-debug
description: 排错指南。预览白屏、报错、500、编译失败、样式不生效、数据不见了等问题时使用；含常见错误→修法对照表与回退策略。
---

# 排错：按路径查，不要瞎试

## 排查路径（按顺序）

1. **`npx tsc --noEmit`** —— 类型错误先清零，一半的"白屏"是编译挂了。
2. **看 dev server 日志** —— 编译错误、Server Action 抛错、平台 API 报错都在这里；日志由 runtime 托管，不要自己重启 dev server（重启也不解决代码错误）。
3. **看页面表现分类**：白屏/错误页 → 服务端渲染抛错，日志里有堆栈；交互没反应 → 多半是 Server/Client 边界问题；数据不对 → 看下面"数据类"。
4. 修复 → 复检（回到第 1 步）。**最多迭代 3 次**，仍失败就如实告诉用户卡点和已尝试的方案，不要无限循环。

## 常见错误 → 修法

| 症状 / 报错 | 原因 | 修法 |
| --- | --- | --- |
| `useState/useEffect is not a function` 或 hooks 报错 | Server Component 里用了 hooks | 文件顶部加 `"use client"`，或把交互部分拆成小的 client 组件 |
| `Event handlers cannot be passed to Client Component props` | 服务端组件把函数传给客户端 | 交互下沉到 client 组件；提交动作用 Server Action（`"use server"`） |
| 调 `db/kv/storage/ai/currentUser` 报错或 500 | 在浏览器端调了平台能力 | 平台能力**只能在服务端**：Server Component / Server Action / Route Handler；客户端经 Server Action 中转 |
| Hydration failed / 内容闪变 | SSR 与客户端首渲不一致（`Date.now()`、`Math.random()`、`toLocaleString` 直接进 JSX） | 随机/时间值放服务端算好当 props 传，或放 `useEffect` 后再渲染 |
| `Property 'id' does not exist on type '() => Promise<AppUser \| null>'` | 把 `currentUser` 当对象用了——它是异步函数 | `const me = await currentUser(); me?.id`；同类：凡报错类型形如 `() => Promise<…>` 都是忘了调用/await |
| 表单提交后 500 | `formData.get('x') as string` 断言，实际是 null/File | 用 zod `safeParse`（见 `chatu-validation`），失败分支要处理 |
| 列表更新了但页面不变 | Server Action 后没刷新缓存 | Action 末尾 `revalidatePath('/路由')` |
| `params`/`searchParams` 类型报错 | Next 16 里它们是 Promise | `const { id } = await params` |
| 样式不生效 | 想改 `tailwind.config`（本模板没有）或类名拼错 | 主题改 `globals.css` 的 `@theme`；动态类名不要字符串拼接（Tailwind 扫不到），用完整类名条件切换 |
| `Module not found` | import 路径错或包没装 | 检查 `@/` 别名路径；确需新包先想能否用已装依赖，安装只用 **npm** |
| fetch 第三方接口失败 | 沙箱经代理出网，个别域名未放行 | 用普通 `fetch`（代理已自动配置）；仍失败则如实告知用户该域名不可达，不要绕代理 |
| 数据重启后没了 | 用的是内存数据层（recipe 默认） | 正常现象；要持久化就接 `chatu-db` |

## 回退策略

- 一次只改一处，改完立即验证；同时改多处会分不清是哪个改坏的。
- 越改越坏时：恢复到本轮开始的状态（重新读文件、撤销本轮改动），换一个最小方案重来；**不要**自己执行 git 命令（版本由 runtime 托管）。
- 修复引入的新报错比原问题还多时，优先回退而不是继续打补丁。

## 禁忌

- 不要 `rm -rf node_modules` / 重装依赖来"试试看"——慢且几乎不解决代码问题。
- 不要自行启动/停止/重启 dev server、改端口。
- 不要为绕过类型错误用 `as any` / `@ts-ignore`——它们只是把 500 从编译期挪到运行期。
