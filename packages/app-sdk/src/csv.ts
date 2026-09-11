/**
 * CSV 导出 / 导入（技术方案 34 §4）：后台列表"导出 Excel"、批量导入是生成应用的高频需求，
 * 但 CSV 的转义、Excel 的中文乱码（要 UTF-8 BOM）、带逗号换行的值，agent 每次现写都会错一两处。
 * 纯函数，零依赖，浏览器端也能用。
 */

export interface CsvColumn<T> {
  /** 取值字段名，支持 a.b 点路径 */
  key: string
  /** 表头文字（默认用 key） */
  label?: string
  /** 自定义取值/格式化（如把毫秒时间戳转成日期） */
  value?: (row: T) => unknown
}

export interface ToCsvOptions<T> {
  /** 要导出的列与顺序；不传则用所有行里出现过的字段（首次出现的顺序） */
  columns?: Array<string | CsvColumn<T>>
  /** 是否输出表头行，默认 true */
  header?: boolean
  /** 是否加 UTF-8 BOM，默认 true —— Excel 不加 BOM 打开中文是乱码 */
  bom?: boolean
  /** 分隔符，默认 , */
  delimiter?: string
}

function resolvePath(row: any, path: string): unknown {
  if (path in (row ?? {})) return row[path]
  let cur: any = row
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

function cell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 行数组 → CSV 文本。
 * ```ts
 * const csv = toCsv(docs, { columns: ['title', { key: '_createdAt', label: '创建时间', value: d => new Date(d._createdAt).toLocaleString('zh-CN') }] })
 * ```
 */
export function toCsv<T extends Record<string, any>>(rows: T[], opts?: ToCsvOptions<T>): string {
  const delimiter = opts?.delimiter ?? ','
  const cols: CsvColumn<T>[] = (opts?.columns ?? inferColumns(rows)).map(c => (typeof c === 'string' ? { key: c } : c))
  const lines: string[] = []
  if (opts?.header !== false) lines.push(cols.map(c => cell(c.label ?? c.key, delimiter)).join(delimiter))
  for (const row of rows) {
    lines.push(cols.map(c => cell(c.value ? c.value(row) : resolvePath(row, c.key), delimiter)).join(delimiter))
  }
  return (opts?.bom === false ? '' : '﻿') + lines.join('\r\n')
}

function inferColumns<T extends Record<string, any>>(rows: T[]): string[] {
  const keys: string[] = []
  for (const row of rows) for (const k of Object.keys(row ?? {})) if (!keys.includes(k)) keys.push(k)
  return keys
}

export interface ParseCsvResult {
  header: string[]
  /** 每行按表头取值；缺列补空串（行号 = 下标 + 2，报错时给用户看的就是这个） */
  rows: Array<Record<string, string>>
}

/**
 * CSV 文本 → 表头 + 行对象。处理引号转义、值里的换行、CRLF 与 BOM。
 * 导入前**务必**用 zod 逐行校验再 `insertMany`（见 chatu-admin 的 references/export-import.md）。
 */
export function parseCsv(text: string, opts?: { delimiter?: string }): ParseCsvResult {
  const delimiter = opts?.delimiter ?? ','
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const table: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === delimiter) { row.push(field); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field); table.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); table.push(row) }
  const header = (table.shift() ?? []).map(h => h.trim())
  const rows = table
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { header, rows }
}
