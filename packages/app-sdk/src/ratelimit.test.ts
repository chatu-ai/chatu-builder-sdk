import { beforeEach, describe as d, expect, it } from 'vitest'
import { configure, kv, ratelimit } from './index'

d('ratelimit', () => {
  beforeEach(() => configure({ driver: 'memory' }))

  it('窗口内放行 limit 次，超出后 ok=false 且 remaining=0', async () => {
    const results = []
    for (let i = 0; i < 4; i += 1) results.push(await ratelimit('u1', { limit: 3, window: 60 }))
    expect(results.map(r => r.ok)).toEqual([true, true, true, false])
    expect(results.map(r => r.remaining)).toEqual([2, 1, 0, 0])
    expect(results.at(-1)!.count).toBe(4)
    expect(results[0]!.reset).toBeGreaterThan(0)
    expect(results[0]!.reset).toBeLessThanOrEqual(60)
  })

  it('不同 key / 不同 prefix 互不影响，桶键按时间窗分片', async () => {
    await ratelimit('u1', { limit: 1, window: 60 })
    expect((await ratelimit('u2', { limit: 1, window: 60 })).ok).toBe(true)
    expect((await ratelimit('u1', { limit: 1, window: 60, prefix: 'sms' })).ok).toBe(true)
    const bucket = Math.floor(Math.floor(Date.now() / 1000) / 60)
    const keys = (await kv.list('')).keys
    expect(keys).toContain(`rl:u1:${bucket}`)
    expect(keys).toContain(`sms:u1:${bucket}`)
  })

  it('桶键会随窗口过期（incr 不会把 TTL 冲掉）', async () => {
    const realNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now
    try {
      await ratelimit('ttl-probe', { limit: 5, window: 60 })
      await ratelimit('ttl-probe', { limit: 5, window: 60 })   // 第二次 incr 之后 TTL 必须还在
      const bucketKey = `rl:ttl-probe:${Math.floor(Math.floor(now / 1000) / 60)}`
      expect((await kv.list('rl:')).keys).toContain(bucketKey)
      now += 121_000                                     // 超过 window * 2 的 TTL
      expect(await kv.get(bucketKey)).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('进入下一个时间窗后计数重置', async () => {
    const realNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now
    try {
      expect((await ratelimit('u1', { limit: 1, window: 60 })).ok).toBe(true)
      expect((await ratelimit('u1', { limit: 1, window: 60 })).ok).toBe(false)
      now += 60_000
      const next = await ratelimit('u1', { limit: 1, window: 60 })
      expect(next.ok).toBe(true)
      expect(next.count).toBe(1)
    } finally {
      Date.now = realNow
    }
  })
})
