/** 内置脚本：DoD 场景 1（生成落地页）与场景 2（增量修改+断线注入）。 */
import type { MockScript } from './index'

const X = 'xid-mock-1'
const PREVIEW = 'https://sbx-mock.n.example.com'

/** DoD 场景 1：prompt → 任务卡渐进 → 文件生成 → 预览就绪 → 版本 → done */
export const scenario1: MockScript = {
  name: 'dod-1-landing-page',
  steps: [
    { event: { kind: 'ack', xid: X, seq: 0, sandbox: { sandboxId: 'sbx-mock', state: 'warming', previewUrl: PREVIEW } } },
    { event: { kind: 'taskCard', xid: X, seq: 1, id: 'tc1', label: '初始化模板', state: 'running' }, delayMs: 300 },
    { event: { kind: 'taskCard', xid: X, seq: 2, id: 'tc1', label: '初始化模板', state: 'done' }, delayMs: 500 },
    { event: { kind: 'taskCard', xid: X, seq: 3, id: 'tc2', label: '生成页面', state: 'running' }, delayMs: 200 },
    { event: { kind: 'message', xid: X, seq: 4, role: 'assistant', text: '正在为你创建产品落地页，包含 Hero、特性与 CTA 区块……' }, delayMs: 300 },
    { event: { kind: 'fileDiff', xid: X, seq: 5, path: 'app/page.tsx', action: 'create', bytes: 4096, truncated: false, diff: '+ export default function Landing() { ... }' }, delayMs: 600 },
    { event: { kind: 'fileDiff', xid: X, seq: 6, path: 'components/hero.tsx', action: 'create', bytes: 2048, truncated: false }, delayMs: 400 },
    { event: { kind: 'taskCard', xid: X, seq: 7, id: 'tc2', label: '生成页面', state: 'done' }, delayMs: 200 },
    { event: { kind: 'taskCard', xid: X, seq: 8, id: 'tc3', label: '启动开发服务器', state: 'running' }, delayMs: 300 },
    { event: { kind: 'preview', xid: X, seq: 9, state: 'starting' }, delayMs: 800 },
    { event: { kind: 'preview', xid: X, seq: 10, state: 'ready', url: PREVIEW }, delayMs: 700 },
    { event: { kind: 'taskCard', xid: X, seq: 11, id: 'tc3', label: '启动开发服务器', state: 'done' } },
    { event: { kind: 'version', xid: X, seq: 12, sha: 'aaa111', message: 'create landing page', filesChanged: 2 }, delayMs: 200 },
    { event: { kind: 'done', xid: X, seq: 13, state: 'completed' } },
  ],
}

/** DoD 场景 2：增量修改（改主色）+ 中途断线（验证重连与 seq 去重） */
export const scenario2: MockScript = {
  name: 'dod-2-incremental-with-drop',
  initialTree: [
    { path: 'app', type: 'dir', children: [{ path: 'page.tsx', type: 'file' }] },
    { path: 'components', type: 'dir', children: [{ path: 'hero.tsx', type: 'file' }] },
  ],
  steps: [
    { event: { kind: 'ack', xid: X, seq: 0, sandbox: { sandboxId: 'sbx-mock', state: 'ready', previewUrl: PREVIEW } } },
    { event: { kind: 'taskCard', xid: X, seq: 1, id: 'tc1', label: '定位样式定义', state: 'running' }, delayMs: 300 },
    { event: { kind: 'taskCard', xid: X, seq: 2, id: 'tc1', label: '定位样式定义', state: 'done' }, delayMs: 400, dropConnectionAfter: true },
    { event: { kind: 'fileDiff', xid: X, seq: 3, path: 'app/globals.css', action: 'modify', bytes: 512, truncated: false, diff: '- --primary: blue\n+ --primary: green' }, delayMs: 300 },
    { event: { kind: 'preview', xid: X, seq: 4, state: 'ready', url: PREVIEW }, delayMs: 400 },
    { event: { kind: 'version', xid: X, seq: 5, sha: 'bbb222', message: 'change primary color to green', filesChanged: 1 } },
    { event: { kind: 'done', xid: X, seq: 6, state: 'completed' } },
  ],
}
