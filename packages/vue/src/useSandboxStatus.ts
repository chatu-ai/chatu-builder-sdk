import { onScopeDispose, readonly, ref } from 'vue'
import type { BuilderClient, SandboxStatus } from '@chatu-builder-sdk/core'

export interface SandboxStatusOptions {
  /** 状态轮询间隔（恢复中等过渡态使用），默认 2000ms */
  pollMs?: number
  /** 心跳间隔（08 §4：页面可见才发），默认 30000ms */
  heartbeatMs?: number
  /** 可见性探针（默认读 document.visibilityState；测试可注入） */
  isVisible?: () => boolean
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

/**
 * 沙箱状态 + 心跳组合式 API（08 §4）
 * tab 隐藏即停心跳（省 TTL）；恢复期加速轮询由调用方通过 refresh 触发。
 */
export function useSandboxStatus(
  client: BuilderClient,
  conversationId: string,
  opts: SandboxStatusOptions = {},
) {
  const status = ref<SandboxStatus | null>(null)
  const error = ref<string | null>(null)

  const isVisible =
    opts.isVisible ??
    (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'))
  const setI = opts.setInterval ?? globalThis.setInterval.bind(globalThis)
  const clearI = opts.clearInterval ?? globalThis.clearInterval.bind(globalThis)

  async function refresh(): Promise<void> {
    try {
      status.value = await client.sandbox.status(conversationId)
      error.value = null
    } catch (err) {
      error.value = String(err)
    }
  }

  async function beatOnce(): Promise<void> {
    if (!isVisible()) return
    try {
      await client.sandbox.heartbeat(conversationId, { visible: true })
    } catch {
      // 心跳失败不打扰用户；状态轮询会暴露真实问题
    }
  }

  const heartbeatTimer = setI(() => void beatOnce(), opts.heartbeatMs ?? 30_000)
  const pollTimer = setI(() => void refresh(), opts.pollMs ?? 2_000)

  function stop(): void {
    clearI(heartbeatTimer)
    clearI(pollTimer)
  }

  onScopeDispose(stop)
  void refresh()
  void beatOnce()

  return { status: readonly(status), error: readonly(error), refresh, stop }
}
