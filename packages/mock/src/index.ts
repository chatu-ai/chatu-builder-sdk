/**
 * createMockBuilderClient —— 按脚本回放事件序列（08 §6）。
 * 内置脚本对应 DoD 场景 1（落地页生成）与场景 2（增量修改），支持延时与断线注入。
 */
import type { BuilderClient, BuilderEvent } from '@chatu-builder-sdk/core'

export interface MockScriptStep {
  event: BuilderEvent
  delayMs?: number
  /** 在该步之后注入一次断线（验证 resubscribe/seq 去重） */
  dropConnectionAfter?: boolean
}

export interface MockScript {
  name: string
  steps: MockScriptStep[]
}

export function createMockBuilderClient(_script: MockScript): BuilderClient {
  // TODO(M4-W1): 实现脚本回放；内置 scenario1/scenario2 脚本随实现提交
  throw new Error('not implemented: see 003.技术方案/08 §6')
}
