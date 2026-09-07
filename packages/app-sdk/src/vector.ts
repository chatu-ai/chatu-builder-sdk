import type { Collection, Doc, Filter } from './db.js'
import { AppSdkError } from './errors.js'

/**
 * 向量检索（知识库 / 语义搜索 / 相似推荐）的应用内实现：向量随文档存进 db 集合的一个字段，
 * 查询时拉回候选文档在进程内算余弦相似度排序。没有服务端向量索引，适用规模见 vectorSearch 的说明。
 */

/** 余弦相似度，范围 [-1, 1]；维度不一致抛错 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new AppSdkError('VECTOR_DIMENSION_MISMATCH', `向量维度不一致：${a.length} vs ${b.length}`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RankOptions {
  /** 返回前几条，默认 5 */
  topK?: number
  /** 低于该相似度的丢弃（默认不过滤；0.3~0.5 常用） */
  minScore?: number
}
export interface Ranked<T> { item: T; score: number }

/** 对一批候选按与 query 的余弦相似度降序排列 */
export function rankBySimilarity<T>(query: ArrayLike<number>, items: T[], getVector: (item: T) => ArrayLike<number> | null | undefined, opts?: RankOptions): Ranked<T>[] {
  const topK = Math.max(1, opts?.topK ?? 5)
  const out: Ranked<T>[] = []
  for (const item of items) {
    const v = getVector(item)
    if (!v || v.length === 0) continue
    const score = cosineSimilarity(query, v)
    if (opts?.minScore !== undefined && score < opts.minScore) continue
    out.push({ item, score })
  }
  out.sort((x, y) => y.score - x.score)
  return out.slice(0, topK)
}

export interface VectorSearchOptions<T> extends RankOptions {
  /** 存向量的字段名，默认 `embedding` */
  field?: string
  /** 先按业务条件缩小候选（如 `{ userId }`），再算相似度——强烈建议带上 */
  filter?: Filter<T>
  /** 最多扫描多少条候选，默认 2000（每 200 条一次请求） */
  scanLimit?: number
}

/**
 * 在 db 集合里做向量检索：分页拉回候选（每页 200 条）→ 进程内算相似度 → 取 topK。
 * 适用规模：单次检索候选 ≤ 2000 条（默认 scanLimit）。更大的知识库请先用 filter 分片，或告知用户当前平台不支持。
 * 返回的文档会去掉向量字段本身（体积大且对调用方无用）。
 */
export async function vectorSearch<T = Record<string, unknown>>(collection: Collection<T>, query: ArrayLike<number>, opts?: VectorSearchOptions<T>): Promise<Ranked<Doc<T>>[]> {
  const field = opts?.field ?? 'embedding'
  const scanLimit = Math.max(1, opts?.scanLimit ?? 2000)
  const candidates: Doc<T>[] = []
  let skip: number | null = 0
  while (skip !== null && candidates.length < scanLimit) {
    const page = await collection.find({ filter: opts?.filter, skip, limit: 200 })
    candidates.push(...page.docs)
    skip = page.nextSkip
  }
  const ranked = rankBySimilarity(query, candidates.slice(0, scanLimit), d => (d as Record<string, unknown>)[field] as number[] | undefined, opts)
  return ranked.map(({ item, score }) => {
    const { [field]: _omit, ...rest } = item as Record<string, unknown>
    return { item: rest as Doc<T>, score }
  })
}

export interface SplitTextOptions {
  /** 每段最大字符数，默认 500（中文按字算；embedding 模型按 token 计，500 字很安全） */
  chunkSize?: number
  /** 相邻段重叠字符数，默认 50，保证跨段语义不断裂 */
  overlap?: number
}

/**
 * 长文本切段（入库前用）：优先在段落 / 句号 / 换行处断开，超长再硬切；相邻段带重叠。
 * 返回的每段都已 trim 且非空。
 */
export function splitText(text: string, opts?: SplitTextOptions): string[] {
  const chunkSize = Math.max(50, opts?.chunkSize ?? 500)
  const overlap = Math.min(Math.max(0, opts?.overlap ?? 50), Math.floor(chunkSize / 2))
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkSize)
    if (end < normalized.length) {
      // 从 end 往回找最近的自然断点（段落 > 句末 > 空白），但至少要吃掉半个 chunk
      const window = normalized.slice(start, end)
      const floor = Math.floor(chunkSize / 2)
      const candidates = [window.lastIndexOf('\n\n'), Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
      const cut = candidates.find(i => i >= floor)
      if (cut !== undefined) end = start + cut + 1
    }
    const piece = normalized.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= normalized.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}
