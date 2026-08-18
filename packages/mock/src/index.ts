/**
 * createMockBuilderClient —— 按脚本回放事件序列（08 §6）。
 * 支持延时与断线注入；断线后 resubscribe 从 lastSeq 续传（与真实服务端语义一致），
 * 因此 UI 对 mock 与真实 client 的行为观感完全相同。
 */
import type {
  BuilderClient, BuilderEvent, FileNode, SandboxStatus, VersionInfo,
} from '@chatu-ai/builder-sdk'
import { resilientStream } from '@chatu-ai/builder-sdk'

export interface MockScriptStep {
  event: BuilderEvent
  delayMs?: number
  /** 在该步之后注入一次断线（验证 resubscribe/seq 去重） */
  dropConnectionAfter?: boolean
}

export interface MockScript {
  name: string
  steps: MockScriptStep[]
  /** 初始文件树（fileDiff 事件会在其上演进） */
  initialTree?: FileNode[]
}

export interface MockBuilderClient extends BuilderClient {
  /** 测试辅助：当前沙箱状态（随 preview 事件演进） */
  readonly currentStatus: SandboxStatus
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function createMockBuilderClient(script: MockScript): MockBuilderClient {
  let status: SandboxStatus = { state: 'creating' }
  const versions: VersionInfo[] = []
  let tree: FileNode[] = script.initialTree ?? []
  let dropped = false // 每脚本只断线一次

  function applySideEffects(ev: BuilderEvent) {
    if (ev.kind === 'ack') status = { state: ev.sandbox.state, previewUrl: ev.sandbox.previewUrl }
    if (ev.kind === 'preview') status = {
      ...status,
      state: ev.state === 'ready' ? 'ready' : status.state,
      previewUrl: ev.url ?? status.previewUrl,
      devServer: { running: ev.state === 'ready', lastError: ev.error ?? undefined },
    }
    if (ev.kind === 'version') versions.unshift({
      sha: ev.sha, message: ev.message, filesChanged: ev.filesChanged, createdAt: new Date().toISOString(),
    })
    if (ev.kind === 'fileDiff') tree = upsertPath(tree, ev.path, ev.action === 'delete')
  }

  async function* replay(fromSeq: number): AsyncIterable<BuilderEvent | null> {
    for (const step of script.steps) {
      const ev = step.event
      if (ev.kind !== 'ack' && ev.seq <= fromSeq) continue // 服务端回放语义
      if (step.delayMs) await sleep(step.delayMs)
      applySideEffects(ev)
      yield ev
      if (step.dropConnectionAfter && !dropped) {
        dropped = true
        throw new Error('mock: connection dropped')
      }
    }
  }

  const stream = (fromSeq: number) => resilientStream(
    { open: () => replay(fromSeq), reopen: seq => replay(seq) },
    { baseDelayMs: 10 },
  )

  return {
    get currentStatus() { return status },
    chat: {
      stream: () => stream(0),
      resubscribe: (_c, _x, lastSeq) => stream(lastSeq),
      cancel: async () => { status = { ...status, state: 'ready' } },
    },
    sandbox: {
      status: async () => status,
      heartbeat: async () => {},
      previewToken: async () => ({ token: 'mock-token', previewUrl: `${status.previewUrl ?? ''}/?t=mock-token` }),
      wake: async () => { status = { ...status, state: 'ready' }; return status },
      share: async () => ({ url: 'https://sbx-mock.test/?s=mock', token: 'mock', expiresAt: new Date(Date.now() + 86400000).toISOString() }),
      revokeShare: async () => ({ ok: true }),
      restartDevServer: async (_id, opts) => ({ ok: true, ready: false, cleaned: !!opts?.clean }),
      hibernate: async () => { status = { ...status, state: 'hibernated' }; return { ok: true, state: 'hibernated' } },
      terminate: async () => { status = { ...status, state: 'recycled' }; return { ok: true, state: 'recycled' } },
    },
    versions: {
      list: async () => versions,
      restore: async (_id, sha) => {
        const i = versions.findIndex(v => v.sha === sha)
        if (i < 0) throw new Error(`mock: unknown version ${sha}`)
        versions.splice(0, i) // 回滚 = 丢弃更新的版本
      },
    },
    files: {
      tree: async () => tree,
      read: async (_id, path) => `// mock content of ${path}\n`,
      downloadUrl: () => 'https://mock.invalid/download.zip',
      download: async () => ({ blob: new Blob(['mock'], { type: 'text/plain' }), contentType: 'text/plain' }),
    },
    credentials: {
      list: async () => [
        { id: 'cred-1', scope: 'user', provider: 'github', label: '我的 GitHub', hint: 'ab12', createdTime: new Date().toISOString(), readOnly: false },
        { id: 'cred-org', scope: 'organization', provider: 'git-https', label: '公司 GitLab 机器人', hint: 'zz99', createdTime: new Date().toISOString(), readOnly: true },
      ],
      save: async input => ({ id: 'cred-new', scope: input.scope, provider: input.provider, label: input.label, hint: input.secret.slice(-4), createdTime: new Date().toISOString(), readOnly: false }),
      remove: async () => {},
    },
    deploy: {
      settings: async () => [{ target: 'git', credentialId: 'cred-1', config: { remoteUrl: 'https://github.com/demo/app.git', branch: 'main' }, updatedTime: new Date().toISOString() }],
      saveSetting: async (_id, input) => ({ target: input.target, credentialId: input.credentialId ?? null, config: input.config ?? {}, updatedTime: new Date().toISOString() }),
      deployFunctionStream: async function* (_id, input) {
        yield { type: 'log', line: '▶ 构建 Next.js standalone 产物 …' }
        yield { type: 'log', line: `▶ 部署 ${input.name}（${input.region}）…` }
        yield { type: 'result', result: { ok: true, provider: input.provider, name: input.name, region: input.region, url: `https://${input.name}.mock.fcapp.run`, output: 'mock' } }
      },
      deployStream: async function* (_id, input) {
        yield { type: 'log', line: '▶ 关联 EdgeOne 项目 …' }
        yield { type: 'log', line: '▶ 构建并部署 …' }
        yield { type: 'result', result: { ok: true, projectName: input.projectName, env: input.env ?? 'production', url: `https://${input.projectName}.edgeone.app`, output: 'mock' } }
      },
      deploy: async (_id, input) => ({ ok: true, projectName: input.projectName, env: input.env ?? 'production', url: `https://${input.projectName}.edgeone.app`, output: 'mock deploy ok', envVarsApplied: 3 }),
      pushGit: async (_id, input) => ({ ok: true, remoteUrl: input.remoteUrl, branch: input.branch ?? 'main', sha: 'deadbeefcafe', output: 'mock push ok', webUrl: input.remoteUrl.replace(/\.git$/, '') }),
      pushGitStream: async function* (_id, input) {
        yield { type: 'log', line: '▶ 检查工作区未提交改动 …' }
        yield { type: 'log', line: `▶ 推送到 ${input.remoteUrl}（分支 ${input.branch ?? 'main'}）…` }
        yield { type: 'log', line: 'Writing objects: 100% (12/12), done.' }
        yield { type: 'result', result: { ok: true, remoteUrl: input.remoteUrl, branch: input.branch ?? 'main', sha: 'deadbeefcafe', output: 'mock push ok', webUrl: input.remoteUrl.replace(/\.git$/, '') } }
      },
    },
    data: {
      kv: {
        list: async () => ({ ok: true, keys: ['todos:1', 'todos:2', 'views'], nextCursor: null }),
        get: async (_id, key) => ({ ok: true, key, value: key === 'views' ? 42 : { title: 'demo', done: false }, exists: true, ttl: null }),
        set: async () => ({ ok: true }),
        remove: async () => ({ ok: true, removed: true }),
      },
      db: {
        collections: async () => ({ ok: true, collections: [{ name: 'todos', count: 2 }] }),
        query: async () => ({ ok: true, docs: [{ _id: 'a1', _createdAt: Date.now(), _updatedAt: Date.now(), title: 'mock todo', done: false }], total: 1, nextSkip: null }),
        replace: async (_id, _coll, docId, doc) => ({ ok: true, doc: { _id: docId, ...doc } }),
        remove: async () => ({ ok: true, removed: true }),
        drop: async () => ({ ok: true, dropped: true }),
      },
      storage: {
        list: async () => ({ ok: true, items: [{ key: 'uploads/a.png', size: 1024, lastModified: new Date().toISOString() }], nextCursor: null }),
        sign: async (_id, key) => ({ ok: true, url: `https://mock.invalid/${key}` }),
        uploadUrl: async (_id, key) => ({ ok: true, url: `https://mock.invalid/upload/${key}`, method: 'PUT' as const }),
        remove: async () => ({ ok: true }),
      },
      promote: async () => ({ ok: true, kv: { copied: 12, skipped: 0 }, storage: { copied: 2, skipped: 0, bytes: 2048 } }),
      export: async (_id, env) => ({ ok: true, env: env ?? 'prod', kv: [{ key: 'todos:1', value: { a: 1 }, ttl: null }], storage: [{ key: 'img/a.png', size: 10, url: 'https://mock/a.png' }] }),
      usage: async () => ({ ok: true, month: '2026-08', readOnly: false, dev: { raw: { kv_ops: 1234, st_ops: 12, st_put_bytes: 1048576 }, points: 12 }, prod: { raw: {}, points: 0 }, rates: { KvOpsPerPoint: 100 } }),
      access: async () => ({ baseUrl: 'https://api.mock/data/v1', apiKey: 'sk-conv-mock', envs: ['dev', 'prod'], envVars: { CHATU_DATA_URL: 'https://api.mock/data/v1', CHATU_APP_KEY: 'sk-conv-mock', CHATU_DATA_ENV: 'prod' } }),
    },
    logs: {
      tail: async () => ({ lines: ['▲ Next.js 16 dev', '- Local: http://localhost:3001', '✓ Ready in 1.2s'] }),
    },
    export: {
      zip: async () => ({ blob: new Blob(['PK'], { type: 'application/zip' }), fileName: 'mock-app.zip' }),
    },
  }
}

/** 极简树维护：仅保证 path 出现/消失，目录按需创建 */
function upsertPath(tree: FileNode[], path: string, remove: boolean): FileNode[] {
  const [head, ...rest] = path.split('/')
  const next = tree.filter(n => n.path !== head)
  if (remove && rest.length === 0) return next
  const existing = tree.find(n => n.path === head)
  if (rest.length === 0) return [...next, { path: head, type: 'file' }]
  const dir: FileNode = existing?.type === 'dir' ? existing : { path: head, type: 'dir', children: [] }
  return [...next, { ...dir, children: upsertPath(dir.children ?? [], rest.join('/'), remove) }]
}

export * from './scenarios'
