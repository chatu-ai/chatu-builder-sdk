import { describe as d, expect, it } from 'vitest'
import { ai, configure, getAi } from './index'
import { deriveAiBaseUrl } from './config'

const sse = (lines: string[]) => new ReadableStream<Uint8Array>({
  start(c) {
    const enc = new TextEncoder()
    // 故意把行切开成不规则的 chunk，验证跨 chunk 拼接
    const text = lines.map(l => `${l}\n\n`).join('')
    for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)))
    c.close()
  },
})

d('deriveAiBaseUrl', () => {
  it('maps /data/v1 to /v1 and falls back to origin', () => {
    expect(deriveAiBaseUrl('https://api.chatuapi.com/data/v1')).toBe('https://api.chatuapi.com/v1')
    expect(deriveAiBaseUrl('http://chatu-function.chatu.svc.cluster.local/data/v1/')).toBe('http://chatu-function.chatu.svc.cluster.local/v1')
    expect(deriveAiBaseUrl('https://api.test/other')).toBe('https://api.test/v1')
  })
})

d('ai platform driver', () => {
  it('chat: posts OpenAI-compatible body with Bearer auth and parses content/usage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'x', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', model: 'default-m', fetchImpl })
    const r = await ai.chat('hi', { temperature: 0.2, maxTokens: 10, extra: { top_p: 0.9 } })
    expect(r).toEqual({ content: 'hello', model: 'gpt-x', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } })
    expect(calls[0]!.url).toBe('https://api.test/v1/chat/completions')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer sk-conv-abc')
    expect(h['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ top_p: 0.9, model: 'default-m', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 10 })
    // 显式 model 覆盖默认；aiBaseUrl 显式覆盖推导
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', aiBaseUrl: 'https://ai.test/v1/', apiKey: 'sk-conv-abc', fetchImpl })
    await getAi().chat([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], { model: 'm2' })
    expect(calls[1]!.url).toBe('https://ai.test/v1/chat/completions')
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ model: 'm2', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
  })

  it('chat: non-2xx becomes AppSdkError with server code/status', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_POINTS', message: 'no points' } }), { status: 402 })) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    await expect(ai.chat('hi')).rejects.toMatchObject({ name: 'AppSdkError', code: 'INSUFFICIENT_POINTS', message: 'no points', status: 402 })
  })

  it('stream: yields delta text from SSE and stops at [DONE]', async () => {
    let body: unknown
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        ': keep-alive',
        'data: {"choices":[{"delta":{"content":"lo, "}}]}',
        'data: {"choices":[{"delta":{"content":"世界"}}]}',
        'data: [DONE]',
        'data: {"choices":[{"delta":{"content":"IGNORED"}}]}',
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    const parts: string[] = []
    for await (const t of ai.stream('hi')) parts.push(t)
    expect(parts).toEqual(['Hel', 'lo, ', '世界'])
    expect(body).toMatchObject({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect((body as any).model).toBeUndefined()
  })

  it('models: lists ids', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    expect(await ai.models()).toEqual(['a', 'b'])
  })
})

d('ai without platform config', () => {
  it('throws AI_NOT_CONFIGURED for memory driver', async () => {
    configure({ driver: 'memory' })
    await expect(ai.chat('hi')).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
    await expect(ai.models()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
    await expect((async () => { for await (const _ of ai.stream('hi')) { /* noop */ } })()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  })
})

d('ai.json（结构化输出）', () => {
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], model: 'm1' }), { status: 200 })

  it('解析纯 JSON，并带上 response_format 与 schema 提示', async () => {
    const calls: any[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return reply('{"title":"买牛奶","done":false}')
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })

    const schema = { type: 'object', properties: { title: { type: 'string' } } }
    const out = await ai.json<{ title: string; done: boolean }>('提取待办', { schema })
    expect(out).toEqual({ title: '买牛奶', done: false })
    expect(calls[0].response_format).toEqual({ type: 'json_object' })
    expect(JSON.stringify(calls[0].messages[0].content)).toContain('JSON Schema')
  })

  it('剥掉 ```json 代码围栏与前后废话', async () => {
    const fetchImpl = (async () =>
      reply('好的，结果如下：\n```json\n{"a":1}\n```')) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    expect(await ai.json('x')).toEqual({ a: 1 })
  })

  it('校验不过会带着错误重试，第二次通过', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return reply(n === 1 ? '{"count":"多"}' : '{"count":3}')
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })

    const validate = (v: unknown) => {
      const c = (v as { count: unknown }).count
      if (typeof c !== 'number') throw new Error('count 必须是数字')
      return { count: c }
    }
    expect(await ai.json('数一下', { validate })).toEqual({ count: 3 })
    expect(n).toBe(2)
  })

  it('重试用尽仍不合格则抛 AppSdkError', async () => {
    const fetchImpl = (async () => reply('不是 JSON')) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    await expect(ai.json('x', { retries: 0 })).rejects.toMatchObject({ code: 'AI_INVALID_JSON' })
  })
})
