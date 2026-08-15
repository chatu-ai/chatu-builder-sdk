# chatu-builder-sdk

ChatU Builder 客户端 SDK monorepo。设计文档见 `~/tfs/v0/003.技术方案/`（04 §1 SDK 体系、08 §2 API 面、03 §2 事件 schema）。

## 包

| 包 | 说明 | 阶段 |
| --- | --- | --- |
| `@chatu-builder-sdk/core` | A2A + REST client、zod 事件 schema（单一事实源）、seq 去重与断线重连 | P0 |
| `@chatu-builder-sdk/mock` | 脚本化事件回放（含断线注入），供 UI 先行开发 | P0 |
| `@chatu-builder-sdk/vue` | Vue 3 组合式 API 绑定 | P0–P1 |
| `@chatu-builder-sdk/react` | React 绑定（对外开放主力） | P1 末–P2 |
| `@chatu-builder-sdk/embed` / `ai-tools` | 嵌入 widget / MCP 工具集 | P2 |

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
