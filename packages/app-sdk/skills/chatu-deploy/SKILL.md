---
name: chatu-deploy
description: 发布与部署（EdgeOne Pages 一键部署 / 推送 Git 仓库 / 导出 ZIP / 云函数）。用户说"发布/上线/部署/怎么让别人访问/导出代码"，或部署失败要排查时使用；含部署前自检清单、线上与预览的差异、失败对照表。
---

# 发布与部署

**发布动作由用户在界面上点，你不要替用户执行部署**（也没有相应的命令）。你的职责是：① 把代码写成能顺利构建的样子；② 用户问怎么发布时说清路径；③ 部署失败时按下面的对照表改代码。

## 四条发布路径（用户在发布面板里选）

| 路径 | 用户操作 | 产物 |
| --- | --- | --- |
| **EdgeOne Pages 一键部署**（最常用） | 发布面板 →「部署到腾讯云 EdgeOne Pages」→ 填项目名 + 令牌 → 开始部署 | 一个可访问的线上域名；平台数据变量自动注入 |
| **腾讯云函数（SCF）** | 发布面板 → 函数部署 → 填访问密钥 | 函数 + API 网关地址 |
| **推送到 Git 仓库** | 发布面板 →「推送到 Git 仓库」 | 用户自己的仓库，之后可导入任意平台 |
| **导出 ZIP** | 发布面板 → 导出 | 含 `Dockerfile`、`docker-compose.yml`、`DEPLOY.md`、`.env.example` 的标准 Next.js 项目 |

**构建发生在当前沙箱内**（不是云端构建）：`npm install` → `next build` → 上传产物。所以**依赖越重、构建越慢也越容易失败**——这是"不要装超重依赖"的直接原因。

## 部署前自检清单（写代码时就要守住）

1. **只用 npm**。不要用 pnpm / yarn，也不要留下 `pnpm-lock.yaml` / `yarn.lock`——多余的锁文件会让构建走 pnpm 的 frozen-lockfile 而失败。锁文件只能是 `package-lock.json`。
2. **不要用 `next/font/google`**。构建环境访问不了 `fonts.googleapis.com`，会直接构建失败。用模板已有的字体方案（`src/lib/platform/font-shim.ts` 的 `googleFont("Inter")`）或纯 CSS 字体栈。
3. **不要删 layout 里的 `export const dynamic = "force-dynamic"`**。平台数据能力与 Server Actions 需要动态渲染；删了会让线上出现"数据不刷新/登录态丢失"。
4. **密钥不进代码**。`CHATU_APP_KEY` 及任何第三方密钥只能从 `process.env` 读，且**只能在服务端**用；绝不写进源码、不加 `NEXT_PUBLIC_` 前缀、不传给客户端组件。
5. **`npx tsc --noEmit` 必须过**，且预览里页面能正常打开（见 `chatu-verify`）——构建失败最常见的原因就是类型错误。
6. 需要环境变量时，告诉用户去底部面板的 **「环境变量」** Tab 添加（值加密保存，注入预览与部署目标，导出 ZIP 时只出 `.env.example`），**不要**让用户把密钥贴进对话里，也不要自己创建 `.env` 文件。

## 线上要用的平台数据变量

应用通过 `@chatu-ai/app-sdk` 访问平台数据（kv/db/storage/auth/ai），线上需要三个变量：

| 变量 | 值 |
| --- | --- |
| `CHATU_DATA_URL` | 平台 Data API 地址 |
| `CHATU_APP_KEY` | 会话密钥（`sk-conv-…`） |
| `CHATU_DATA_ENV` | `prod` |

- **一键部署（EdgeOne / 函数）时平台自动注入**，用户什么都不用填。
- **手动导入仓库到第三方平台**时要用户自己贴：发布面板「数据与密钥」里可一键复制。
- 第三方平台导入时列出的其它变量（`CHATU_AI_URL`、`CHATU_AI_MODEL`、`PRIMARY_MODEL`、`CHATU_AUTH_SESSION_CACHE` 等）**都是可选的**，不填走默认值，可以直接跳过。

## 预览（dev）与线上（prod）的差异

- **数据是两套命名空间**：预览写的数据不会出现在线上。用户问"线上怎么没有我刚才录的数据"时，如实说明，并告诉他发布面板有 dev→prod 的数据复制功能。
- 应用用户（`chatu-auth`）同理：预览注册的测试账号不会带到线上。
- 预览用 `next dev`、线上是 `next build` 产物：**只在 dev 能跑的写法（比如依赖开发期宽松行为的代码）会在构建时暴露**，所以类型必须干净。

## 失败对照表

| 现象 / 日志 | 原因 | 修法 |
| --- | --- | --- |
| 构建失败，日志提到 `next/font/google` 或 `fonts.googleapis.com` | 构建环境访问不了 Google Fonts | 改用 `googleFont()` 替身或 CSS 字体栈（见上） |
| `frozen-lockfile` / pnpm 相关报错 | 工作区里混进了 `pnpm-lock.yaml` / `yarn.lock` | 删掉多余锁文件，只保留 `package-lock.json` |
| 构建失败且是类型/编译错误 | 预览期没跑干净 `tsc` | 先 `npx tsc --noEmit` 清零再让用户重试部署 |
| 线上白屏或 500，但预览正常 | 多半是删了 `force-dynamic`，或代码里读了预览才有的环境变量 | 恢复 `force-dynamic`；环境变量缺失要有兜底 |
| 线上报数据/AI 不可用（`*_NOT_CONFIGURED`） | 手动导入时没配 `CHATU_DATA_URL` / `CHATU_APP_KEY` | 让用户从「数据与密钥」复制三个变量到部署平台 |
| 线上调 auth 报 `AUTH_UNSUPPORTED` | 部署时选了 EdgeOne 存储驱动（无平台数据服务） | 需要登录功能就改用平台数据接入部署 |
| 部署日志里是云厂商的鉴权/授权错误 | 用户的令牌/密钥权限不足或未开通对应服务 | 这是用户侧的账号配置问题，如实转述错误，不要改代码"绕过" |
| 部署很慢或超时 | 依赖过重、构建在沙箱内跑 | 检查是否装了不必要的重依赖；能用已装依赖就别装新的 |

## 禁忌

- 不要自己执行 git 命令或部署命令（版本与部署都由平台托管）。
- 不要为了"让构建过"而 `as any` / `@ts-ignore` / 关掉类型检查——线上会以运行时 500 的形式炸出来。
- 不要在代码里硬编码线上域名；需要绝对地址时用相对路径或环境变量。
- 用户没要求发布时，不要主动催他发布。
