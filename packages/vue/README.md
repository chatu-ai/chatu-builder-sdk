# @chatu-ai/builder-sdk-vue

Vue 3 composables for [`@chatu-ai/builder-sdk`](https://www.npmjs.com/package/@chatu-ai/builder-sdk).

```ts
import { useSandboxStatus, usePreviewUrl, useBuilderChat } from '@chatu-ai/builder-sdk-vue'

const { state, refresh } = useSandboxStatus(client, conversationId)   // adaptive polling + heartbeat
const { url } = usePreviewUrl(client, conversationId)                  // one-time preview token → iframe src
```

Peer dependency: `vue ^3.4`. MIT
