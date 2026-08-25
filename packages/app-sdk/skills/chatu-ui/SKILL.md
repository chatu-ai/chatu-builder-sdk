---
name: chatu-ui
description: 界面与样式规范（shadcn + Tailwind v4）。写页面/组件、用户说"不好看/丑/改样式/换配色"、做响应式适配时使用。
---

# 界面规范：快速也要好看

## Tailwind v4 与本模板的差异（易错）

- **没有 `tailwind.config.js`**。主题在 `src/app/globals.css` 用 `@theme` / CSS 变量定义；改主色调改那里，不要新建 config 文件。
- 颜色优先用语义 token：`bg-background` / `text-foreground` / `text-muted-foreground` / `bg-muted` / `text-primary` / `border`——它们自动适配深色模式；只有装饰性渐变才用具体色（`from-indigo-600`）。
- 合并 className 用 `cn()`（`@/lib/utils`），不要手拼三元字符串。

## shadcn 组合惯例

- 只从 `@/components/ui/*` 引基础组件，业务组件放 `src/components/`；**不要重写 ui/ 下同名组件**。
- **本模板 shadcn 基于 @base-ui，不是 Radix**：没有 `asChild`，组合用 `render` 属性——链接按钮写 `<Button render={<Link href="/x" />}>文案</Button>`。
- 需要未预装的 shadcn 组件：`npx shadcn@latest add <name>`；先想想已装 20 个能否组合出来。
- 常用骨架：页面 = `<main className="mx-auto max-w-*xl px-4 py-10">` + 语义化 header；列表项/信息块用 `Card`；操作确认用 `Dialog`；侧边抽屉用 `Sheet`；轻提示用 `sonner` 的 `toast()`（client 组件里调用）。
- 图标用 `lucide-react`，尺寸 `size-4`/`size-5` 与文字对齐。

## 三态齐全（列表/数据页必须有）

| 态 | 写法 |
| --- | --- |
| 空态 | 居中一句引导文案（告诉用户第一步做什么），可配一个淡色图标；不要留白板 |
| 加载态 | `Skeleton` 占位（数量与真实条目接近）；Server Component 首屏自带数据时可省 |
| 错误态 | 淡红底提示条 + 重试入口；不要把异常堆栈给用户看 |

## 响应式

- 移动优先：默认单列，`sm:`/`md:` 逐级增强（如 `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`）。
- 容器：`mx-auto max-w-2xl`（内容页）/ `max-w-4xl`（列表后台）/ `max-w-6xl`（宽仪表盘）。
- 触控目标 ≥ 40px：按钮用默认 size，不要为了紧凑用 `size="sm"` 堆一排。

## 中文排版细节

- 标题 `tracking-tight`；正文行高 `leading-6`/`leading-7`；大段文字限宽 `max-w-prose`。
- 数字/时间用 `toLocaleString("zh-CN")`；金额保留两位小数并带 ¥。
- 文案口吻一致（都用"你"不用"您"，或反之）；按钮用动词（"添加""保存"），不用"确定/OK"。

## 禁忌

- 不装其他 UI 库（antd / mui / chakra / daisyui…）——和模板主题冲突且体积大。
- 图片：优先 CSS 渐变 / SVG / lucide 图标 / 占位色块；外链图仅用用户提供的 URL；不要写进 `public/`。
- 不用 `next/font/google`（沙箱出网不稳，模板已有 font-shim）。
- 深色模式：用语义 token 就自动支持，**不要**手写 `dark:` 覆盖一大片。
