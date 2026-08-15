import { ref, watch, type Ref } from 'vue'
import type { BuilderClient } from '@chatu-builder-sdk/core'

/**
 * 预览地址（带一次性 token 的 iframe src，06 §6.1）：
 * - 沙箱 previewUrl 出现/变化时取一次 token
 * - 授权失效（预览域授权页 postMessage）时调用 refresh() 重取
 * token 一次性：每次 refresh 都签发新 token，旧 iframe 已兑换为 cookie 不受影响
 */
export function usePreviewUrl(client: BuilderClient, conversationId: string, rawPreviewUrl: Ref<string | undefined>) {
  const src = ref<string | undefined>(undefined)
  const error = ref<string | null>(null)
  let seq = 0

  async function refresh(): Promise<void> {
    if (!rawPreviewUrl.value) {
      src.value = undefined
      return
    }
    const my = ++seq
    try {
      const { previewUrl } = await client.sandbox.previewToken(conversationId)
      if (my === seq) {
        src.value = previewUrl
        error.value = null
      }
    } catch (err) {
      if (my === seq) error.value = String(err)
    }
  }

  watch(rawPreviewUrl, () => void refresh(), { immediate: true })

  return { src, error, refresh }
}
