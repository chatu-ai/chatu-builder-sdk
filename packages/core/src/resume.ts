/**
 * 弹性事件流：seq 去重（xid 作用域）+ 断线自动 resubscribe（指数退避）。
 * 保证下游拿到的流有序无重；ack(seq=0) 不参与去重。
 */
import type { BuilderEvent } from './events'

export interface ResumeSource {
  /** 初始流 */
  open(): AsyncIterable<BuilderEvent | null>
  /** 断线后按 lastSeq 重订阅 */
  reopen(lastSeq: number): AsyncIterable<BuilderEvent | null>
}

export interface ResilienceOptions {
  maxRetries?: number       // 默认 3
  baseDelayMs?: number      // 默认 500（指数退避：500/1000/2000）
  sleep?: (ms: number) => Promise<void>
}

export async function* resilientStream(
  source: ResumeSource,
  opts: ResilienceOptions = {},
): AsyncIterable<BuilderEvent> {
  const maxRetries = opts.maxRetries ?? 3
  const baseDelay = opts.baseDelayMs ?? 500
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))

  let lastSeq = 0
  let retries = 0
  let iterable = source.open()

  for (;;) {
    try {
      for await (const ev of iterable) {
        if (ev === null) continue
        if (ev.kind !== 'ack') {
          if (ev.seq <= lastSeq) continue // 去重/乱序丢弃
          lastSeq = ev.seq
        }
        retries = 0 // 有数据即重置退避
        yield ev
        if (ev.kind === 'done') return
      }
      return // 流正常结束
    } catch (err) {
      if (retries >= maxRetries) throw err
      await sleep(baseDelay * 2 ** retries)
      retries++
      iterable = source.reopen(lastSeq)
    }
  }
}
