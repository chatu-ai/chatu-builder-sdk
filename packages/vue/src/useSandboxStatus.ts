import { onScopeDispose, readonly, ref } from 'vue'
import type { BuilderClient, SandboxStatus } from '@chatu-ai/builder-sdk'

export interface SandboxStatusOptions {
  /** 过渡态（创建/预热/恢复/快照/未知）轮询间隔，默认 3000ms */
  pollMs?: number
  /** 稳定态（ready/busy）轮询间隔，默认 60000ms——此时状态主要由 SSE 事件与心跳响应维护 */
  idlePollMs?: number
  /** 休眠态轮询间隔，默认 15000ms（等待唤醒） */
  hibernatedPollMs?: number
  /** 心跳间隔（08 §4：页面可见才发），默认 30000ms */
  heartbeatMs?: number
  /** 可见性探针（默认读 document.visibilityState；测试可注入） */
  isVisible?: () => boolean
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

const TRANSITIONAL = new Set(['requested', 'creating', 'warming', 'resuming', 'snapshotting'])

/**
 * 沙箱状态 + 心跳组合式 API（08 §4）
 * - 自适应轮询：过渡态密集、稳定态稀疏、休眠态中等；页面隐藏时不轮询、不心跳
 * - 心跳响应携带 state，稳定态下以此为主要状态来源，避免高频打 status
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
  const pollMs = opts.pollMs ?? 3_000
  const idlePollMs = opts.idlePollMs ?? 60_000
  const hibernatedPollMs = opts.hibernatedPollMs ?? 30_000

  let lastPoll = 0

  // 过渡态/编译中持续过久时逐级退避（避免异常卡住时每 3s 打一次接口）：<2min 按 pollMs，<5min 4×，之后 10×
  let fastSince = 0
  function backoff(base: number): number {
    const now = Date.now()
    if (!fastSince) fastSince = now
    const elapsed = now - fastSince
    if (elapsed > 5 * 60_000) return base * 10
    if (elapsed > 2 * 60_000) return base * 4
    return base
  }
  function currentInterval(): number {
    const s = status.value?.state
    if (!s || TRANSITIONAL.has(s)) return backoff(pollMs)
    if (s === 'hibernated') { fastSince = 0; return hibernatedPollMs }
    // dev server 仍在编译：按过渡态频率轮询，就绪后自动放慢
    if (status.value?.devServer && status.value.devServer.running && status.value.devServer.ready === false) return backoff(pollMs)
    fastSince = 0
    return idlePollMs
  }

  async function refresh(): Promise<void> {
    lastPoll = Date.now()
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
      const r = (await client.sandbox.heartbeat(conversationId, { visible: true })) as
        | { state?: SandboxStatus['state'] }
        | void
      // 心跳响应带 state（BuilderController），稳定态下据此更新，免打 status
      if (r && typeof r === 'object' && r.state && status.value) {
        status.value = { ...status.value, state: r.state }
      }
    } catch {
      // 心跳失败不打扰用户；状态轮询会暴露真实问题
    }
  }

  // 单一 1s tick 调度器：按当前状态决定是否到期轮询（避免多定时器切换）
  const tick = setI(() => {
    if (!isVisible()) return
    if (Date.now() - lastPoll >= currentInterval()) void refresh()
  }, 1_000)
  const heartbeatTimer = setI(() => void beatOnce(), opts.heartbeatMs ?? 30_000)

  function stop(): void {
    clearI(tick)
    clearI(heartbeatTimer)
  }

  onScopeDispose(stop)
  void refresh()
  void beatOnce()

  return { status: readonly(status), error: readonly(error), refresh, stop }
}
