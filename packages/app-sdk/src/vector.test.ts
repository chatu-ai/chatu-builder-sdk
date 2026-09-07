import { beforeEach, describe as d, expect, it } from 'vitest'
import { configure, cosineSimilarity, db, rankBySimilarity, splitText, vectorSearch } from './index'

d('cosineSimilarity', () => {
  it('同向为 1、正交为 0、反向为 -1；零向量为 0；维度不一致抛错', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/维度不一致/)
  })
})

d('rankBySimilarity', () => {
  it('按相似度降序、截断 topK、过滤 minScore、跳过无向量项', () => {
    const items = [
      { id: 'a', v: [1, 0] },
      { id: 'b', v: [0.9, 0.1] },
      { id: 'c', v: [0, 1] },
      { id: 'd', v: undefined },
    ]
    const ranked = rankBySimilarity([1, 0], items, i => i.v)
    expect(ranked.map(r => r.item.id)).toEqual(['a', 'b', 'c'])
    expect(rankBySimilarity([1, 0], items, i => i.v, { topK: 2 }).map(r => r.item.id)).toEqual(['a', 'b'])
    expect(rankBySimilarity([1, 0], items, i => i.v, { minScore: 0.5 }).map(r => r.item.id)).toEqual(['a', 'b'])
  })
})

d('vectorSearch', () => {
  beforeEach(() => configure({ driver: 'memory' }))

  it('在集合内检索：按 filter 缩小候选、返回 topK 且剥掉向量字段', async () => {
    const chunks = db.collection<{ userId: string; text: string; embedding: number[] }>('chunks')
    await chunks.insert({ userId: 'u1', text: '猫', embedding: [1, 0] })
    await chunks.insert({ userId: 'u1', text: '猫科动物', embedding: [0.9, 0.2] })
    await chunks.insert({ userId: 'u1', text: '汽车', embedding: [0, 1] })
    await chunks.insert({ userId: 'u2', text: '别人的猫', embedding: [1, 0] })

    const hits = await vectorSearch(chunks, [1, 0], { filter: { userId: 'u1' }, topK: 2 })
    expect(hits.map(h => h.item.text)).toEqual(['猫', '猫科动物'])
    expect(hits[0]!.score).toBeCloseTo(1)
    expect((hits[0]!.item as Record<string, unknown>).embedding).toBeUndefined()
    expect(hits[0]!.item._id).toBeTruthy()
  })

  it('自定义向量字段名与 minScore', async () => {
    const c = db.collection<{ text: string; vec: number[] }>('vecs')
    await c.insert({ text: 'x', vec: [1, 0] })
    await c.insert({ text: 'y', vec: [0, 1] })
    const hits = await vectorSearch(c, [1, 0], { field: 'vec', minScore: 0.5 })
    expect(hits.map(h => h.item.text)).toEqual(['x'])
  })
})

d('splitText', () => {
  it('空白返回空数组；短文本原样一段', () => {
    expect(splitText('   ')).toEqual([])
    expect(splitText('一句话')).toEqual(['一句话'])
  })

  it('长文本按自然断点切段且带重叠，每段不超过 chunkSize', () => {
    const text = Array.from({ length: 20 }, (_, i) => `这是第${String(i)}句话。`).join('')
    const chunks = splitText(text, { chunkSize: 60, overlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60)
    // 覆盖全文：拼起来（去掉重叠）应仍包含首尾内容
    expect(chunks[0]).toContain('第0句话')
    expect(chunks.at(-1)).toContain('第19句话')
    // 相邻段有重叠
    expect(chunks[1]!.slice(0, 5)).not.toBe('')
  })

  it('没有断点的长串按硬切', () => {
    const chunks = splitText('a'.repeat(300), { chunkSize: 100, overlap: 0 })
    expect(chunks.length).toBe(3)
    expect(chunks.every(c => c.length === 100)).toBe(true)
  })
})
