import { describe, expect, it } from 'vitest'
import { Agent3Translator } from './agent3'

const X = 'xid-1'
const sdk = (seq: number, type: string, content: unknown) => ({ xid: X, sequenceNumber: seq, type, content })

describe('Agent3Translator', () => {
  it('translates builder-ack into ack event with seq 0', () => {
    const t = new Agent3Translator()
    const evs = t.translate({ type: 'builder-ack', seq: 0, sandbox: { sandboxId: 'chat-use-abc', state: 'ready', previewUrl: 'https://chat-use-abc.n.y.com' } })
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'ack', seq: 0, sandbox: { sandboxId: 'chat-use-abc' } })
  })

  it('assistant text + tool_use -> message + running taskCard (+ fileDiff for Write)', () => {
    const t = new Agent3Translator()
    const evs = t.translate(sdk(3, 'chunk', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '开始创建首页' },
          { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/workspace/src/app/page.tsx', content: 'export default 1' } },
        ],
      },
    }))
    expect(evs.map(e => e.kind)).toEqual(['message', 'taskCard', 'fileDiff'])
    expect(evs[1]).toMatchObject({ kind: 'taskCard', id: 'tc_tu_1', label: '写入文件', state: 'running' })
    expect(evs[2]).toMatchObject({ kind: 'fileDiff', path: 'src/app/page.tsx', action: 'create' })
  })

  it('tool_result marks matching card done/failed with empty label (state-only upsert)', () => {
    const t = new Agent3Translator()
    t.translate(sdk(1, 'chunk', { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_9', name: 'Bash', input: { command: 'npm i' } }] } }))
    const evs = t.translate(sdk(2, 'step', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', is_error: true }] } }))
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'taskCard', id: 'tc_tu_9', state: 'failed', label: '' })
  })

  it('complete/error -> done', () => {
    const t = new Agent3Translator()
    expect(t.translate(sdk(9, 'complete', { subtype: 'success' }))[0]).toMatchObject({ kind: 'done', state: 'completed' })
    expect(t.translate(sdk(10, 'error', { message: 'boom' }))[0]).toMatchObject({ kind: 'done', state: 'failed', error: 'boom' })
  })

  it('ignores status/created-response/garbage', () => {
    const t = new Agent3Translator()
    expect(t.translate(sdk(1, 'status', { subtype: 'init' }))).toEqual([])
    expect(t.translate({ type: 'created-response', xid: 'x' })).toEqual([])
    expect(t.translate('not json')).toEqual([])
    expect(t.translate({ type: 'chunk' })).toEqual([]) // 无 xid/seq
  })
})
