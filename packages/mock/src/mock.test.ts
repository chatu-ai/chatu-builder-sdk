import { describe, expect, it } from 'vitest'
import type { BuilderEvent } from '@chatu-ai/builder-sdk'
import { createMockBuilderClient, scenario1, scenario2 } from './index'

async function collect(src: AsyncIterable<BuilderEvent>): Promise<BuilderEvent[]> {
  const out: BuilderEvent[] = []
  for await (const e of src) out.push(e)
  return out
}

describe('mock client', () => {
  it('replays scenario1 completely and updates status/versions/tree', async () => {
    const client = createMockBuilderClient(structuredClone(scenario1))
    const events = await collect(client.chat.stream('c1', 'make a landing page'))

    expect(events.at(0)?.kind).toBe('ack')
    expect(events.at(-1)).toMatchObject({ kind: 'done', state: 'completed' })
    expect(client.currentStatus.state).toBe('ready')
    expect(client.currentStatus.devServer?.running).toBe(true)
    expect(await client.versions.list('c1')).toHaveLength(1)
    const tree = await client.files.tree('c1')
    expect(tree.find(n => n.path === 'app')).toBeTruthy()
  })

  it('scenario2 survives injected disconnect with no gaps or dupes', async () => {
    const client = createMockBuilderClient(structuredClone(scenario2))
    const events = await collect(client.chat.stream('c1', 'change color'))
    const seqs = events.filter(e => e.kind !== 'ack').map(e => e.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]) // 断线后续传，无重无漏
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('restore rolls back version list', async () => {
    const client = createMockBuilderClient(structuredClone(scenario1))
    await collect(client.chat.stream('c1', 'x'))
    await client.versions.restore('c1', 'aaa111')
    expect((await client.versions.list('c1'))[0]?.sha).toBe('aaa111')
  })
})
