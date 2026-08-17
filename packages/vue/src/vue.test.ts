import { describe, expect, it, vi } from 'vitest'
import { createMockBuilderClient, scenario1, scenario2 } from '@chatu-ai/builder-sdk-mock'
import { useBuilderChat } from './useBuilderChat'
import { useSandboxStatus } from './useSandboxStatus'
import { createInitialState, reduceEvent } from './reducer'

function fastScenario(s: typeof scenario1) {
  return { ...s, steps: s.steps.map(st => ({ ...st, delayMs: 0 })) }
}

describe('reducer', () => {
  it('reduces scenario1 event sequence into complete UI state', () => {
    const state = createInitialState()
    for (const step of scenario1.steps) reduceEvent(state, step.event)

    expect(state.agentState).toBe('idle') // done(completed) 收尾
    expect(state.rounds).toHaveLength(1)
    const round = state.rounds[0]
    expect(round.taskCards.map(c => c.state)).toEqual(['done', 'done', 'done']) // 三张卡全 done（原位更新）
    expect(state.changedPaths).toContain('app/page.tsx')
    expect(state.sandbox.state).toBe('ready')
    expect(state.versions[0]?.sha).toBe('aaa111')
    expect(round.version?.sha).toBe('aaa111')
  })

  it('taskCard upserts by id instead of appending', () => {
    const state = createInitialState()
    reduceEvent(state, { kind: 'taskCard', xid: 'x', seq: 1, id: 't1', label: 'a', state: 'running' })
    reduceEvent(state, { kind: 'taskCard', xid: 'x', seq: 2, id: 't1', label: 'a', state: 'done' })
    expect(state.rounds[0].taskCards).toHaveLength(1)
    expect(state.rounds[0].taskCards[0].state).toBe('done')
  })

  it('preview crashed records lastError; ready clears it', () => {
    const state = createInitialState()
    reduceEvent(state, { kind: 'preview', xid: 'x', seq: 1, state: 'crashed', error: 'boom' })
    expect(state.sandbox.lastError).toBe('boom')
    reduceEvent(state, { kind: 'preview', xid: 'x', seq: 2, state: 'ready', url: 'https://a.b' })
    expect(state.sandbox.lastError).toBeNull()
    expect(state.sandbox.state).toBe('ready')
  })
})

describe('useBuilderChat', () => {
  it('streams scenario to completion and rejects concurrent send (R11)', async () => {
    const client = createMockBuilderClient(fastScenario(scenario1))
    const chat = useBuilderChat(client, 'c1')

    const sending = chat.send('make a landing page')
    await expect(chat.send('another')).rejects.toThrow('BUSY')
    await sending

    expect(chat.state.agentState).toBe('idle')
    expect(chat.state.rounds[0].done?.state).toBe('completed')
    expect(chat.isStreaming.value).toBe(false)
  })

  it('survives scenario2 disconnect: state complete, no duplicate task cards', async () => {
    const client = createMockBuilderClient(fastScenario(scenario2))
    const chat = useBuilderChat(client, 'c1')
    await chat.send('change color')

    expect(chat.state.rounds[0].taskCards).toHaveLength(1)
    expect(chat.state.versions[0]?.sha).toBe('bbb222')
    expect(chat.state.lastSeq).toBe(6)
  })
})

describe('useSandboxStatus', () => {
  it('polls status and sends heartbeat only when visible', async () => {
    vi.useFakeTimers()
    const client = createMockBuilderClient(fastScenario(scenario1))
    const heartbeat = vi.spyOn(client.sandbox, 'heartbeat')
    let visible = true

    const s = useSandboxStatus(client, 'c1', {
      isVisible: () => visible,
      heartbeatMs: 1000,
      pollMs: 500,
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(heartbeat).toHaveBeenCalled()

    const callsWhenVisible = heartbeat.mock.calls.length
    visible = false
    await vi.advanceTimersByTimeAsync(3000)
    expect(heartbeat.mock.calls.length).toBe(callsWhenVisible) // 隐藏后不再心跳

    s.stop()
    vi.useRealTimers()
  })
})
