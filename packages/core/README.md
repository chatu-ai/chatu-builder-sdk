# @chatu-ai/builder-sdk

Framework-agnostic client for the ChatU **App Builder** (AI-driven app generation with a live sandbox preview).

```ts
import { createBuilderClient, CookieAuth } from '@chatu-ai/builder-sdk'

const client = createBuilderClient({
  restBase: 'https://your-chatu-host/web/Builder',
  auth: new CookieAuth(),          // or new ApiKeyAuth('...')
  transport,                       // streaming transport injected by the host (see docs)
})

const status = await client.sandbox.status(conversationId)
const { previewUrl } = await client.sandbox.previewToken(conversationId)
const versions = await client.versions.list(conversationId)
```

- Zod event schemas (`events.ts`) are the single source of truth for the streaming protocol
- `parseBuilderEvent` + seq-based resume for reconnect-safe consumption
- No login-state assumptions: bring your own `AuthProvider`

Vue bindings: [`@chatu-ai/builder-sdk-vue`](https://www.npmjs.com/package/@chatu-ai/builder-sdk-vue). Mock client for UI dev: [`@chatu-ai/builder-sdk-mock`](https://www.npmjs.com/package/@chatu-ai/builder-sdk-mock).

MIT
