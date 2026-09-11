import { afterAll, beforeEach, describe as d, expect, it } from 'vitest'
import { configure, db, forgetSqlite } from './index'

// 聚合统计（技术方案 35）：与服务端 BuilderDbAggregateTests 用同一组数据和断言，保证两边语义一致
const builtin = (name: string): any => (globalThis as any).process.getBuiltinModule(name)
const { mkdtempSync, rmSync } = builtin('node:fs')
const { tmpdir } = builtin('node:os')
const { join } = builtin('node:path')
const dir: string = mkdtempSync(join(tmpdir(), 'chatu-agg-'))
afterAll(() => { forgetSqlite(); rmSync(dir, { recursive: true, force: true }) })

// 2026-01-01 00:30 UTC = 北京 08:30；2026-01-01 17:00 UTC = 北京 1/2 01:00
const T0101_0030Utc = 1767227400000
const T0101_1700Utc = 1767286800000
const T0203_0000Utc = 1770076800000

// at = 下单时间（毫秒），单独一个字段：_createdAt 由平台生成，测试里不好固定
interface Order { at: number; channel?: string; amount?: number | string; userId?: string; status: string }
const seed = [
  { at: T0101_0030Utc, channel: 'wechat', amount: 100, userId: 'u1', status: 'paid' },
  { at: T0101_0030Utc, channel: 'wechat', amount: 50.5, userId: 'u1', status: 'paid' },
  { at: T0101_1700Utc, channel: 'ali', amount: 30, userId: 'u2', status: 'paid' },
  { at: T0203_0000Utc, channel: 'ali', amount: '不是数字', userId: 'u3', status: 'refunded' },
  { at: T0203_0000Utc, amount: 20, status: 'paid' },
]

const drivers: Array<[string, () => void]> = [
  ['memory', () => configure({ driver: 'memory' })],
  ['sqlite', () => configure({ driver: 'sqlite', sqlitePath: join(dir, 'agg.sqlite') })],
]

for (const [name, setup] of drivers) {
  d(`${name} driver: aggregate`, () => {
    beforeEach(async () => {
      setup()
      const c = db.collection<Order>('orders')
      await c.drop()
      for (const doc of seed) await c.insert(doc as never)
    })
    const orders = () => db.collection<Order>('orders')

    it('不分组 = 一行 KPI', async () => {
      const [row] = await orders().aggregate({
        metrics: { n: { $count: true }, total: { $sum: 'amount' }, avg: { $avg: 'amount' }, lo: { $min: 'amount' }, hi: { $max: 'amount' }, users: { $countDistinct: 'userId' } },
      })
      expect(row).toEqual({ key: null, n: 5, total: 200.5, avg: 50.125, lo: 20, hi: 100, users: 3 })
    })

    it('按字段分组 + filter + 按指标排序；字段缺失归 key:null', async () => {
      const rows = await orders().aggregate({
        filter: { status: 'paid' },
        groupBy: 'channel',
        metrics: { n: { $count: true }, total: { $sum: 'amount' } },
        sort: { total: -1 },
      })
      expect(rows).toEqual([
        { key: 'wechat', n: 2, total: 150.5 },
        { key: 'ali', n: 1, total: 30 },
        { key: null, n: 1, total: 20 },
      ])
    })

    it('按天分桶默认北京时间；tzOffsetMinutes:0 回到 UTC', async () => {
      const cn = await orders().aggregate({ groupBy: { field: 'at', unit: 'day' }, metrics: { n: { $count: true } } })
      expect(cn).toEqual([{ key: '2026-01-01', n: 2 }, { key: '2026-01-02', n: 1 }, { key: '2026-02-03', n: 2 }])
      const utc = await orders().aggregate({ groupBy: { field: 'at', unit: 'day', tzOffsetMinutes: 0 }, metrics: { n: { $count: true } } })
      expect(utc).toEqual([{ key: '2026-01-01', n: 3 }, { key: '2026-02-03', n: 2 }])
    })

    it('month / hour / week 桶名与 limit 截断', async () => {
      expect(await orders().aggregate({ groupBy: { field: 'at', unit: 'month' }, metrics: { n: { $count: true } } }))
        .toEqual([{ key: '2026-01', n: 3 }, { key: '2026-02', n: 2 }])
      const top = await orders().aggregate({ groupBy: { field: 'at', unit: 'hour' }, metrics: { n: { $count: true } }, sort: { n: -1 }, limit: 1 })
      expect(top).toEqual([{ key: '2026-01-01 08:00', n: 2 }])
      const week = await orders().aggregate({ groupBy: { field: 'at', unit: 'week' }, metrics: { n: { $count: true } } })
      expect(week[0]!.key).toBe('2025-12-29')
    })

    it('非法 metrics / groupBy 抛错', async () => {
      await expect(orders().aggregate({ metrics: {} })).rejects.toMatchObject({ code: 'INVALID_METRICS' })
      await expect(orders().aggregate({ metrics: { x: { $median: 'amount' } as never } })).rejects.toMatchObject({ code: 'INVALID_METRICS' })
      await expect(orders().aggregate({ groupBy: { field: 'at', unit: 'quarter' as never }, metrics: { n: { $count: true } } }))
        .rejects.toMatchObject({ code: 'INVALID_GROUP_BY' })
    })
  })
}

d('platform driver: aggregate 走服务端', () => {
  it('把 filter/groupBy/metrics/sort/limit 原样 POST 到 /aggregate，返回 rows', async () => {
    let body: any = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      body = { url: String(url), json: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ ok: true, rows: [{ key: '2026-01-01', n: 2 }], groups: 3 }), { status: 200 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
    const rows = await db.collection('orders').aggregate({
      filter: { status: 'paid' },
      groupBy: { field: 'at', unit: 'day' },
      metrics: { n: { $count: true } },
      sort: { key: 1 },
      limit: 30,
    })
    expect(body.url).toBe('https://api.test/data/v1/db/orders/aggregate')
    expect(body.json).toEqual({
      filter: { status: 'paid' },
      groupBy: { field: 'at', unit: 'day' },
      metrics: { n: { $count: true } },
      sort: { key: 1 },
      limit: 30,
    })
    expect(rows).toEqual([{ key: '2026-01-01', n: 2 }])
  })
})
