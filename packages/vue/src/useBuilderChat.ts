import { computed, reactive, readonly, ref } from 'vue'
import type { BuilderClient } from '@chatu-builder-sdk/core'
import { createInitialState, reduceEvent, type BuilderUiState } from './reducer'

/**
 * Builder 会话组合式 API（08 §1/§3）
 * 流式消费 client.chat.stream（core 已保证有序无重与断线重连），就地归约到响应式状态。
 */
export function useBuilderChat(client: BuilderClient, conversationId: string) {
  const state = reactive<BuilderUiState>(createInitialState())
  const streamError = ref<string | null>(null)
  let activeXid: string | null = null

  async function send(prompt: string): Promise<void> {
    if (state.agentState === 'streaming') {
      throw new Error('BUSY: a generation is already in progress (R11)')
    }
    state.agentState = 'streaming'
    streamError.value = null
    try {
      let pending = true
      for await (const ev of client.chat.stream(conversationId, prompt)) {
        if (ev.kind === 'ack') activeXid = ev.xid
        reduceEvent(state, ev)
        // 首个带真实 xid 的事件到达后，把用户输入挂到本轮
        if (pending && ev.xid && ev.xid !== 'pending') {
          const round = state.rounds.find(r => r.xid === ev.xid)
          if (round) {
            round.userText = prompt
            pending = false
          }
        }
      }
    } catch (err) {
      state.agentState = 'error'
      streamError.value = String(err)
    } finally {
      activeXid = null
    }
  }

  async function cancel(): Promise<void> {
    if (activeXid) await client.chat.cancel(conversationId, activeXid)
  }

  return {
    state: readonly(state),
    streamError: readonly(streamError),
    isStreaming: computed(() => state.agentState === 'streaming'),
    send,
    cancel,
  }
}
