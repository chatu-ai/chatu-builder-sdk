import { describe, expect, it } from 'vitest'
import type { BuilderEvent } from './events'
import { resilientStream, type ResumeSource } from './resume'

const ev = (seq: number, kind: 'taskCard' | 'done' = 'taskCard'): BuilderEvent =>
  kind === 'done'
    ? { kind: 'done', xid: 'x1', seq, state: 'completed' }
    : { kind: 'taskCard', xid: 'x1', seq, id: `t${seq}`, label: `step ${seq}`, state: 'running' }

async function* iter(events: (BuilderEvent | null)[], failAfter?: number): AsyncIterable<BuilderEvent | null> {
  for (let i = 0; ; i++) {
    if (failAfter !== undefined && i === failAfter) throw new Error('connection dropped')
    if (i >= events.length) return
    yield events[i]
  }
}

async function collect(src: AsyncIterable<BuilderEvent>): Promise<BuilderEvent[]> {
  const out: BuilderEvent[] = []
  for await (const e of src) out.push(e)
  return out
}

const noSleep = { sleep: async () => {}, baseDelayMs: 0 }

describe('resilientStream', () => {
  it('passes events through and stops at done', async () => {
    const src: ResumeSource = {
      open: () => iter([ev(1), ev(2), ev(3, 'done')]),
      reopen: () => iter([]),
    }
    const got = await collect(resilientStream(src, noSleep))
    expect(got.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('dedupes replayed events after reconnect (seq <= lastSeq dropped)', async () => {
    let reopenedWith = -1
    const src: ResumeSource = {
      open: () => iter([ev(1), ev(2)], 2), // 两条后断线
      reopen: lastSeq => {
        reopenedWith = lastSeq
        // 服务端回放含重复（seq 1..2）+ 新事件
        return iter([ev(1), ev(2), ev(3), ev(4, 'done')])
      },
    }
    const got = await collect(resilientStream(src, noSleep))
    expect(reopenedWith).toBe(2)
    expect(got.map(e => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('ack (seq=0) does not affect dedupe window', async () => {
    const ack: BuilderEvent = {
      kind: 'ack', xid: 'x1', seq: 0,
      sandbox: { sandboxId: 'sbx1', state: 'ready', previewUrl: 'https://sbx1.n.example.com' },
    }
    const src: ResumeSource = {
      open: () => iter([ack, ev(1), ev(2, 'done')]),
      reopen: () => iter([]),
    }
    const got = await collect(resilientStream(src, noSleep))
    expect(got[0].kind).toBe('ack')
    expect(got.map(e => e.seq)).toEqual([0, 1, 2])
  })

  it('throws after maxRetries consecutive failures', async () => {
    const src: ResumeSource = {
      open: () => iter([ev(1)], 1),
      reopen: () => iter([], 0), // 每次重连立刻再断
    }
    await expect(collect(resilientStream(src, { ...noSleep, maxRetries: 2 }))).rejects.toThrow('dropped')
  })

  it('skips null (unparsed) events', async () => {
    const src: ResumeSource = {
      open: () => iter([null, ev(1), null, ev(2, 'done')]),
      reopen: () => iter([]),
    }
    const got = await collect(resilientStream(src, noSleep))
    expect(got.map(e => e.seq)).toEqual([1, 2])
  })
})
