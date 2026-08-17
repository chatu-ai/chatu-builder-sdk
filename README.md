# chatu-builder-sdk

Client SDKs for the ChatU **App Builder** — AI-driven app generation with a live sandbox preview. Published on npm under the `@chatu-ai` scope (MIT).

| Package | npm |
| --- | --- |
| `@chatu-ai/builder-sdk` (core) | [![npm](https://img.shields.io/npm/v/@chatu-ai/builder-sdk)](https://www.npmjs.com/package/@chatu-ai/builder-sdk) |
| `@chatu-ai/builder-sdk-vue` | [![npm](https://img.shields.io/npm/v/@chatu-ai/builder-sdk-vue)](https://www.npmjs.com/package/@chatu-ai/builder-sdk-vue) |
| `@chatu-ai/builder-sdk-mock` | [![npm](https://img.shields.io/npm/v/@chatu-ai/builder-sdk-mock)](https://www.npmjs.com/package/@chatu-ai/builder-sdk-mock) |

## 发布流程

```bash
pnpm release:version 0.1.0     # 写入三个包的 version（不打 tag）
git commit -am "release: v0.1.0" && git tag v0.1.0 && git push --tags
```

推 tag 后 GitHub Actions `Release` 自动 build/test 并 `pnpm -r publish`（需仓库 Secret `NPM_TOKEN`）。也可本地 `npm login` 后执行 `pnpm release:publish`。

---


## 包

| 包 | 说明 | 阶段 |
| --- | --- | --- |
| `@chatu-ai/builder-sdk` | A2A + REST client、zod 事件 schema（单一事实源）、seq 去重与断线重连 | P0 |
| `@chatu-ai/builder-sdk-mock` | 脚本化事件回放（含断线注入），供 UI 先行开发 | P0 |
| `@chatu-ai/builder-sdk-vue` | Vue 3 组合式 API 绑定 | P0–P1 |
| `@chatu-ai/builder-sdk-react` | React 绑定（对外开放主力） | P1 末–P2 |
| `@chatu-ai/builder-sdk-embed` / `ai-tools` | 嵌入 widget / MCP 工具集 | P2 |

## 设计约束

1. core 不依赖内部登录态：`AuthProvider` 接口（CookieAuth / ApiKeyAuth）
2. 事件 schema 以 `packages/core/src/events.ts`（zod）为单一事实源，服务端用导出的 JSON Schema 对偶校验
3. A2A 传输层由宿主注入（`A2ATransport` 接口），不重写传输
4. mock 与 core 同 schema，UI 联调换 client 零胶水

## 开发

```bash
pnpm install
pnpm build && pnpm typecheck
```

`packages/core/tsconfig.json` 各包继承根 `tsconfig.base.json`。tsconfig 保持最小，构建产物 `dist/`。
