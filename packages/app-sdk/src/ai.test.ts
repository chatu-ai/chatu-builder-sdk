import { describe as d, expect, it } from 'vitest'
import { ai, configure, getAi, toDataUrl } from './index'
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
    expect(calls[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema, strict: false } })
    expect(JSON.stringify(calls[0].messages[0].content)).toContain('JSON Schema')
  })

  it('没有 schema 时用 json_object', async () => {
    const calls: any[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return reply('{"a":1}') }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    await ai.json('x')
    expect(calls[0].response_format).toEqual({ type: 'json_object' })
  })

  it('json_schema 被服务端拒绝（400 提到 response_format）时降级为 json_object 重发', async () => {
    const calls: any[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push(body)
      if (body.response_format?.type === 'json_schema') return new Response(JSON.stringify({ error: { message: 'response_format json_schema is not supported', code: 'invalid_request_error' } }), { status: 400 })
      return reply('{"title":"t"}')
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    expect(await ai.json('x', { schema: { type: 'object' } })).toEqual({ title: 't' })
    expect(calls.map(c => c.response_format.type)).toEqual(['json_schema', 'json_object'])
  })

  it('schema 本身不合法（400 Invalid schema）不降级，原样抛错', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return new Response(JSON.stringify({ error: { message: "Invalid schema for response_format 'result': 'additionalProperties' is required to be false", code: 'invalid_request_error' } }), { status: 400 })
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    await expect(ai.json('x', { schema: { type: 'object' }, strict: true })).rejects.toMatchObject({ code: 'invalid_request_error', status: 400 })
    expect(n).toBe(1)   // 不重发，不多计一次费
  })

  it('validate 可以直接传 Standard Schema（zod 风格），不合格重试并带 issue 信息', async () => {
    const seen: string[] = []
    let n = 0
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      seen.push(JSON.stringify(body.messages))
      n += 1
      return reply(n === 1 ? '{"age":"x"}' : '{"age":18}')
    }) as unknown as typeof fetch
    configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })
    const std = {
      '~standard': {
        version: 1 as const, vendor: 'test',
        validate: (v: unknown) => (typeof (v as any)?.age === 'number' ? { value: v as { age: number } } : { issues: [{ message: '必须是数字', path: ['age'] }] }),
      },
    }
    expect(await ai.json('x', { validate: std })).toEqual({ age: 18 })
    expect(n).toBe(2)
    expect(seen[1]).toContain('age: 必须是数字')
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

d('ai.chat：多模态与工具调用', () => {
  const cfg = (fetchImpl: typeof fetch) => configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl })

  it('图片片段原样透传；toDataUrl 生成 data URL', async () => {
    let body: any
    const fetchImpl = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '一只猫' }, finish_reason: 'stop' }] })) }) as unknown as typeof fetch
    cfg(fetchImpl)
    const url = toDataUrl(new Uint8Array([1, 2, 3]), 'image/png')
    expect(url).toBe('data:image/png;base64,AQID')
    const r = await ai.chat([{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url, detail: 'low' } }] }])
    expect(r.content).toBe('一只猫')
    expect(r.finishReason).toBe('stop')
    expect(body.messages[0].content).toEqual([{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url, detail: 'low' } }])
  })

  it('tools 转成 OpenAI 格式；返回 toolCalls 且 arguments 已解析', async () => {
    let body: any
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"上海"}' } }] }, finish_reason: 'tool_calls' }] }))
    }) as unknown as typeof fetch
    cfg(fetchImpl)
    const r = await ai.chat('上海天气', { tools: [{ name: 'getWeather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }], toolChoice: { name: 'getWeather' } })
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'getWeather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }])
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'getWeather' } })
    expect(r.content).toBe('')
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'getWeather', arguments: { city: '上海' }, rawArguments: '{"city":"上海"}' }])
  })

  it('runTools：执行工具、回填 tool 消息、直到模型给最终答案', async () => {
    const bodies: any[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      if (bodies.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      return new Response(JSON.stringify({ choices: [{ message: { content: '结果是 3' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }))
    }) as unknown as typeof fetch
    cfg(fetchImpl)
    const seen: string[] = []
    const r = await ai.runTools('1+2=?', { tools: [{ name: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, execute: ({ a, b }: { a: number; b: number }) => a + b }], onToolCall: c => seen.push(c.name) })
    expect(r.content).toBe('结果是 3')
    expect(r.steps).toEqual([{ call: { id: 'c1', name: 'add', arguments: { a: 1, b: 2 }, rawArguments: '{"a":1,"b":2}' }, result: 3 }])
    expect(r.usage).toEqual({ promptTokens: 30, completionTokens: 8, totalTokens: 38 })
    expect(seen).toEqual(['add'])
    // 第二次请求带上了 assistant(tool_calls) + tool 消息
    expect(bodies[1].messages.slice(1)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } }] },
      { role: 'tool', content: '3', name: 'add', tool_call_id: 'c1' },
    ])
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', content: '结果是 3' })
  })

  it('runTools：超过 maxRounds 时最后一轮不带 tools；仍要调工具则抛错', async () => {
    const bodies: any[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'noop', arguments: '{}' } }] } }] }))
    }) as unknown as typeof fetch
    cfg(fetchImpl)
    let executed = 0
    await expect(ai.runTools('x', { tools: [{ name: 'noop', execute: () => { executed += 1; return 'ok' } }], maxRounds: 2 })).rejects.toMatchObject({ code: 'AI_TOOL_ROUNDS_EXCEEDED' })
    expect(bodies.length).toBe(3)
    expect(bodies[0].tools).toBeDefined()
    expect(bodies[2].tools).toBeUndefined()
    // 前两轮各执行一次；放弃的那一轮不能再执行工具（副作用会跑，调用方却只拿到异常）
    expect(executed).toBe(2)
  })

  it('stream 传 tools 直接抛错（SSE 只解析文本增量，否则页面拿到空白）', () => {
    cfg((async () => new Response('')) as unknown as typeof fetch)
    expect(() => (ai as unknown as { stream: (m: string, o: unknown) => unknown }).stream('hi', { tools: [{ name: 'x' }] }))
      .toThrow(/AI_STREAM_TOOLS_UNSUPPORTED|不支持工具调用/)
  })

  it('stream：迭代结束后 usage / content / finishReason 可读', async () => {
    const fetchImpl = (async () => new Response(sse([
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      'data: [DONE]',
    ]))) as unknown as typeof fetch
    cfg(fetchImpl)
    const s = ai.stream('hi')
    const parts: string[] = []
    for await (const t of s) parts.push(t)
    expect(parts).toEqual(['a', 'b'])
    expect(s.content).toBe('ab')
    expect(s.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(s.finishReason).toBe('stop')
  })
})

d('ai.embed / ai.ocr', () => {
  const cfg = (fetchImpl: typeof fetch, extra?: { embedModel?: string }) => configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1', apiKey: 'sk-conv-abc', fetchImpl, ...extra })

  it('embed：POST /v1/embeddings，默认模型 text-embedding-3-small，按 index 归位', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 4, total_tokens: 4 } }))
    }) as unknown as typeof fetch
    cfg(fetchImpl)
    const r = await ai.embedMany(['a', 'b'], { dimensions: 2 })
    expect(calls[0]!.url).toBe('https://api.test/v1/embeddings')
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], encoding_format: 'float', dimensions: 2 })
    expect(r.vectors).toEqual([[1, 0], [0, 1]])
    expect(r.usage?.promptTokens).toBe(4)
    expect(await ai.embed('a')).toEqual([1, 0])
    expect((calls[1]!.body as any).input).toEqual(['a'])
    // configure({ embedModel }) 覆盖默认；空数组不发请求
    cfg(fetchImpl, { embedModel: 'text-embedding-3-large' })
    await ai.embed('z')
    expect(calls[2]!.body.model).toBe('text-embedding-3-large')
    expect(await ai.embedMany([])).toEqual({ vectors: [] })
    expect(calls.length).toBe(3)
  })

  it('embed：服务端少给/越界返回向量时报错，不会把 undefined 当向量返回', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))) as unknown as typeof fetch
    cfg(fetchImpl)
    await expect(ai.embedMany(['a', 'b'])).rejects.toMatchObject({ code: 'AI_EMPTY_EMBEDDING' })
    const outOfRange = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }, { index: 7, embedding: [0, 1] }] }))) as unknown as typeof fetch
    cfg(outOfRange)
    await expect(ai.embedMany(['a', 'b'])).rejects.toMatchObject({ code: 'AI_EMPTY_EMBEDDING' })
  })

  it('ocr：POST {origin}/document-intelligence/analyze，base64 + 附加能力位掩码，解析 content/pages', async () => {
    let seen: { url: string; body: any; headers: Record<string, string> } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ content: '# 标题\n\n正文', pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: 'inch', lines: [{ content: '标题' }, { content: '正文' }] }] }))
    }) as unknown as typeof fetch
    cfg(fetchImpl)
    const r = await ai.ocr(new Uint8Array([1, 2, 3]), { filename: 'a.pdf', features: ['keyValuePairs', 'queryFields'], queryFields: ['金额'] })
    expect(seen!.url).toBe('https://api.test/document-intelligence/analyze')
    expect(seen!.headers.authorization).toBe('Bearer sk-conv-abc')
    expect(seen!.body).toEqual({ filename: 'a.pdf', data: 'AQID', addOns: 32 | 64, queryFields: ['金额'] })
    expect(r.content).toBe('# 标题\n\n正文')
    expect(r.pages).toEqual([{ pageNumber: 1, width: 8.5, height: 11, unit: 'inch', angle: undefined, lines: ['标题', '正文'] }])
    expect(r.raw.pages.length).toBe(1)
  })

  it('ocr：Blob 输入；服务端 BadRequest 纯文本 → AppSdkError', async () => {
    const fetchImpl = (async () => new Response('Insufficient balance.', { status: 400 })) as unknown as typeof fetch
    cfg(fetchImpl)
    await expect(ai.ocr(new Blob([new Uint8Array([1])]), { filename: 'x.png' })).rejects.toMatchObject({ code: 'HTTP_400', message: 'Insufficient balance.', status: 400 })
  })
})
