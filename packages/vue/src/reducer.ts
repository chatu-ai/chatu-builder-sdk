/**
 * 事件 → UI 状态归约（08 §3 规则的纯函数实现，框架无关、可独立测试）
 * vue 层只做响应式包装。
 */
import type { BuilderEvent, SandboxState } from '@chatu-builder-sdk/core'

export interface TaskCardUi {
  id: string
  label: string
  state: 'running' | 'done' | 'failed'
  detail?: string
}

export interface RoundUi {
  xid: string
  text: string
  taskCards: TaskCardUi[]
  version?: { sha: string; message: string; filesChanged: number }
  done?: { state: 'completed' | 'failed' | 'canceled'; error?: string }
}

export interface BuilderUiState {
  agentState: 'idle' | 'streaming' | 'error'
  rounds: RoundUi[]
  sandbox: { state: SandboxState | 'unknown'; previewUrl?: string; lastError?: string | null }
  changedPaths: string[]
  versions: { sha: string; message: string; filesChanged: number }[]
  lastSeq: number
}

export function createInitialState(): BuilderUiState {
  return {
    agentState: 'idle',
    rounds: [],
    sandbox: { state: 'unknown' },
    changedPaths: [],
    versions: [],
    lastSeq: 0,
  }
}

function roundFor(state: BuilderUiState, xid: string): RoundUi {
  let round = state.rounds.find(r => r.xid === xid)
  if (!round) {
    round = { xid, text: '', taskCards: [] }
    state.rounds.push(round)
  }
  return round
}

/** 就地归约（调用方负责传入响应式对象；seq 去重已由 core 保证） */
export function reduceEvent(state: BuilderUiState, ev: BuilderEvent): void {
  if (ev.kind !== 'ack') state.lastSeq = ev.seq

  switch (ev.kind) {
    case 'ack':
      state.agentState = 'streaming'
      state.sandbox = { state: ev.sandbox.state, previewUrl: ev.sandbox.previewUrl }
      roundFor(state, ev.xid)
      break

    case 'message':
      roundFor(state, ev.xid).text += ev.text
      break

    case 'taskCard': {
      const cards = roundFor(state, ev.xid).taskCards
      const existing = cards.find(c => c.id === ev.id)
      if (existing) {
        existing.state = ev.state
        if (ev.label) existing.label = ev.label      // 空 label = 仅状态更新（agent3 tool_result）
        if (ev.detail !== undefined) existing.detail = ev.detail
      } else {
        cards.push({ id: ev.id, label: ev.label, state: ev.state, detail: ev.detail })
      }
      break
    }

    case 'fileDiff':
      if (!state.changedPaths.includes(ev.path)) state.changedPaths.push(ev.path)
      break

    case 'preview':
      state.sandbox = {
        state: ev.state === 'ready' ? 'ready' : state.sandbox.state,
        previewUrl: ev.url ?? state.sandbox.previewUrl,
        lastError: ev.state === 'crashed' ? (ev.error ?? 'dev server crashed') : null,
      }
      break

    case 'version': {
      const version = { sha: ev.sha, message: ev.message, filesChanged: ev.filesChanged }
      roundFor(state, ev.xid).version = version
      state.versions.unshift(version)
      break
    }

    case 'done':
      roundFor(state, ev.xid).done = { state: ev.state, error: ev.error }
      state.agentState = ev.state === 'completed' ? 'idle' : 'error'
      break
  }
}
