import { describe as d, expect, it } from 'vitest'
import { ai, configure } from './index'

// 应用 AI 用量与配额（技术方案 36）
const USAGE_RESPONSE = {
  ok: true,
  month: '2026-09',
  readOnly: false,
  dev: { raw: { kv_ops: 10 }, points: 1 },
  prod: { raw: { kv_ops: 20 }, points: 2 },
  ai: {
    dev: { calls: 12, inputTokens: 34000, outputTokens: 5600, points: 47 },
    prod: { calls: 380, inputTokens: 910000, outputTokens: 120000, points: 1320 },
    total: { calls: 392, inputTokens: 944000, outputTokens: 125600, points: 1367 },
  },
  quota: { monthlyPoints: 2000, used: 1367, remaining: 633 },
}

function stub(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
  configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
  return calls
}

d('ai.usage', () => {
  it('打 Data API 的 usage，带应用密钥；拆成 dev / prod / total / quota', async () => {
    const calls = stub(() => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }))
    const u = await ai.usage()
    expect(calls[0]!.url).toBe('https://api.test/data/v1/usage')
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-conv-abc')
    expect(u.month).toBe('2026-09')
    expect(u.prod).toEqual({ calls: 380, inputTokens: 910000, outputTokens: 120000, points: 1320 })
    expect(u.total.points).toBe(1367)
    expect(u.quota).toEqual({ monthlyPoints: 2000, used: 1367, remaining: 633 })
  })

  it('老服务端没有 ai / quota 块时补 0 与 null，不炸', async () => {
    stub(() => new Response(JSON.stringify({ ok: true, month: '2026-09' }), { status: 200 }))
    const u = await ai.usage()
    expect(u.dev).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, points: 0 })
    expect(u.quota).toEqual({ monthlyPoints: null, used: 0, remaining: null })
  })

  it('setQuota：PUT ai/quota，null 取消', async () => {
    const calls = stub(() => new Response(JSON.stringify({ ok: true, monthlyPoints: 2000, used: 100, remaining: 1900 }), { status: 200 }))
    const q = await ai.setQuota(2000)
    expect(calls[0]!.url).toBe('https://api.test/data/v1/ai/quota')
    expect(calls[0]!.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ monthlyPoints: 2000 })
    expect(q).toEqual({ monthlyPoints: 2000, used: 100, remaining: 1900 })

    const calls2 = stub(() => new Response(JSON.stringify({ ok: true, monthlyPoints: null, used: 100, remaining: null }), { status: 200 }))
    expect(await ai.setQuota(null)).toEqual({ monthlyPoints: null, used: 100, remaining: null })
    expect(JSON.parse(String(calls2[0]!.init.body))).toEqual({ monthlyPoints: null })
  })

  it('没配平台时报 AI_NOT_CONFIGURED', async () => {
    configure({ driver: 'memory' })
    await expect(ai.usage()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
    await expect(ai.setQuota(1)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  })
})

d('AI 调用的错误码归一', () => {
  it('402 ai_quota_exceeded → AI_QUOTA_EXCEEDED；insufficient_balance → AI_INSUFFICIENT_BALANCE', async () => {
    stub(() => new Response(JSON.stringify({ error: { message: '本月 AI 用量已达上限', type: 'insufficient_quota', code: 'ai_quota_exceeded' } }), { status: 402 }))
    await expect(ai.chat('hi')).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED', status: 402 })

    stub(() => new Response(JSON.stringify({ error: { message: 'Insufficient balance.', type: 'invalid_request_error', code: 'insufficient_balance' } }), { status: 400 }))
    await expect(ai.chat('hi')).rejects.toMatchObject({ code: 'AI_INSUFFICIENT_BALANCE' })

    stub(() => new Response(JSON.stringify({ error: { message: 'boom', code: 'upstream_error' } }), { status: 502 }))
    await expect(ai.chat('hi')).rejects.toMatchObject({ code: 'upstream_error' })
  })

  it('AI 请求带 x-chatu-env，用量才会记到正确环境', async () => {
    const calls = stub(() => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200 }))
    await ai.chat('hi')
    expect((calls[0]!.init.headers as Record<string, string>)['x-chatu-env']).toBe('prod')
  })
})
