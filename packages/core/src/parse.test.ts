import { describe, expect, it } from 'vitest'
import { parseBuilderEvent } from './parse'

describe('parseBuilderEvent (03 §2 shapes)', () => {
  it('parses create ack (seq forced to 0)', () => {
    const e = parseBuilderEvent({
      task: { id: 'xid-1', status: { state: 'submitted' } },
      metadata: { seq: 1, sandbox: { sandboxId: 'sbx_a', state: 'resuming', previewUrl: 'https://sbx-a.n.y.com' } },
    })
    expect(e).toMatchObject({ kind: 'ack', xid: 'xid-1', seq: 0, sandbox: { sandboxId: 'sbx_a' } })
  })

  it('parses taskCard status update', () => {
    const e = parseBuilderEvent({
      taskId: 'xid-1', status: { state: 'working' },
      metadata: { seq: 42, taskCard: { id: 'tc_3', label: '安装依赖', state: 'running', detail: 'pnpm add recharts' } },
    })
    expect(e).toMatchObject({ kind: 'taskCard', seq: 42, label: '安装依赖' })
  })

  it('parses fileDiff artifact', () => {
    const e = parseBuilderEvent({
      taskId: 'xid-1',
      artifact: { artifactId: 'file:app/page.tsx', name: 'app/page.tsx', parts: [{ kind: 'text', text: '--- diff' }] },
      metadata: { seq: 43, file: { action: 'modify', bytes: 2048, truncated: false } },
    })
    expect(e).toMatchObject({ kind: 'fileDiff', path: 'app/page.tsx', action: 'modify', diff: '--- diff' })
  })

  it('parses version artifact and done', () => {
    expect(parseBuilderEvent({
      taskId: 'xid-1', artifact: { artifactId: 'version:abc' },
      metadata: { seq: 99, version: { sha: 'abc123', message: 'add landing page', filesChanged: 7 } },
    })).toMatchObject({ kind: 'version', sha: 'abc123' })

    expect(parseBuilderEvent({
      taskId: 'xid-1', status: { state: 'completed' }, metadata: { seq: 100 },
    })).toMatchObject({ kind: 'done', state: 'completed' })
  })

  it('returns null for unknown/malformed events (forward compat)', () => {
    expect(parseBuilderEvent({ metadata: { seq: 1 } })).toBeNull()             // 无 xid
    expect(parseBuilderEvent({ taskId: 'x', metadata: { seq: 1 } })).toBeNull() // 无可识别载荷
    expect(parseBuilderEvent('not-an-object')).toBeNull()
    expect(parseBuilderEvent({ taskId: 'x', metadata: { seq: 1, taskCard: { bad: true } } })).toBeNull() // schema 不符
  })
})
