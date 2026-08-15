/**
 * BuilderClient —— 08 §2 冻结 API 面。
 * A2A 传输层由宿主注入（chat-web 传入 libs/a2a-client 的实例），core 不重写传输。
 */
import type { AuthProvider } from './auth'
import type { BuilderEvent, SandboxState } from './events'

export interface A2ATransport {
  /** message/stream */
  stream(payload: unknown): AsyncIterable<unknown>
  /** tasks/resubscribe */
  resubscribe(taskId: string): AsyncIterable<unknown>
  cancel(taskId: string): Promise<void>
}

export interface BuilderClientOptions {
  restBase: string
  transport: A2ATransport
  auth: AuthProvider
}

export interface SandboxStatus {
  state: SandboxState
  previewUrl?: string
  devServer?: { running: boolean; lastError?: string }
}

export interface VersionInfo { sha: string; message: string; filesChanged: number; createdAt: string }
export interface FileNode { path: string; type: 'file' | 'dir'; children?: FileNode[] }

export interface BuilderClient {
  chat: {
    /** 发送 prompt，返回有序无重（seq 去重后）的事件流；断线自动 resubscribe（指数退避） */
    stream(conversationId: string, prompt: string, opts?: { attachments?: unknown[] }): AsyncIterable<BuilderEvent>
    resubscribe(conversationId: string, xid: string, lastSeq: number): AsyncIterable<BuilderEvent>
    cancel(conversationId: string, xid: string): Promise<void>
  }
  sandbox: {
    status(conversationId: string): Promise<SandboxStatus>
    heartbeat(conversationId: string, opts: { visible: boolean }): Promise<void>
  }
  versions: {
    list(conversationId: string, opts?: { limit?: number }): Promise<VersionInfo[]>
    restore(conversationId: string, sha: string): Promise<void>
  }
  files: {
    tree(conversationId: string, opts?: { path?: string; ref?: string }): Promise<FileNode[]>
    read(conversationId: string, path: string, opts?: { ref?: string }): Promise<string>
    downloadUrl(conversationId: string): Promise<string>
  }
}

export function createBuilderClient(_options: BuilderClientOptions): BuilderClient {
  // TODO(M4-W1): 实现 —— REST 封装 + A2A 事件解析(events.ts schema) + seq 去重/重连
  throw new Error('not implemented: see 003.技术方案/08 §2')
}
