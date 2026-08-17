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

import { createBuilderClient, CookieAuth } from './index'

describe('client req envelope unwrap', () => {
  const mkClient = (body: unknown, ct = 'application/json') =>
    createBuilderClient({
      restBase: 'https://api.test/web/Builder',
      auth: new CookieAuth(),
      transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': ct } })) as unknown as typeof fetch,
    })

  it('unwraps {code:0,data} envelope', async () => {
    const c = mkClient({ code: 0, data: { token: 't', previewUrl: 'https://x/?t=t' } })
    expect(await c.sandbox.previewToken('c1')).toEqual({ token: 't', previewUrl: 'https://x/?t=t' })
  })

  it('passes through raw shapes (ContentResult endpoints)', async () => {
    const c = mkClient({ versions: [{ sha: 'a', message: 'm', filesChanged: 1 }] })
    expect((await c.versions.list('c1'))[0].sha).toBe('a')
  })

  it('throws on non-zero code', async () => {
    const c = mkClient({ code: 400, data: null, message: '会话不存在' })
    await expect(c.sandbox.status('c1')).rejects.toThrow('会话不存在')
  })
})

describe('client export.zip', () => {
  it('returns blob and filename from content-disposition', async () => {
    const c = createBuilderClient({
      restBase: 'https://api.test/web/Builder',
      auth: new CookieAuth(),
      transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
      fetchImpl: (async () => new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="my-app.zip"' },
      })) as unknown as typeof fetch,
    })
    const r = await c.export.zip('c1')
    expect(r.fileName).toBe('my-app.zip')
    expect(r.blob.size).toBe(2)
  })

  it('throws BuilderApiError 409 when sandbox not running', async () => {
    const c = createBuilderClient({
      restBase: 'https://api.test/web/Builder',
      auth: new CookieAuth(),
      transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
      fetchImpl: (async () => new Response('{"error":"SANDBOX_NOT_RUNNING"}', { status: 409 })) as unknown as typeof fetch,
    })
    await expect(c.export.zip('c1')).rejects.toMatchObject({ status: 409 })
  })
})

describe('client credentials/deploy', () => {
  it('posts pushGit body and unwraps envelope', async () => {
    let captured: { url: string; init?: RequestInit } | undefined
    const c = createBuilderClient({
      restBase: 'https://api.test/web/Builder',
      auth: new CookieAuth(),
      transport: { stream: async function* () {}, resubscribe: async function* () {}, cancel: async () => {} },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ code: 0, data: { ok: true, sha: 'abc', branch: 'main' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    const r = await c.deploy.pushGit('c1', { remoteUrl: 'https://github.com/a/b.git', credentialId: 'cred-1' })
    expect(r.ok).toBe(true)
    expect(captured?.url).toBe('https://api.test/web/Builder/c1/export/git')
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({ remoteUrl: 'https://github.com/a/b.git', credentialId: 'cred-1' })
  })
})
