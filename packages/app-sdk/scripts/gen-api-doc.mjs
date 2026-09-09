#!/usr/bin/env node
// 从 dist/*.d.ts 生成 @chatu-ai/app-sdk 的 API 速查表（Markdown），供 Builder SKILL 引用。
//
// 为什么要生成：SKILL 里散文式的 API 描述会落后于 SDK，agent 不确定参数就去读 .d.ts 或写试探代码，
// 一轮对话里大量时间花在"试接口"。速查表随 SDK 一起产出，签名/参数/默认值/说明永远与实际发布的包一致。
//
// 用法：node gen-api-doc.mjs <dts目录> <输出.md>
//   - SDK 仓库 build 时：dist → skills/chatu-quickstart/references/sdk-api.md（随 npm 包一起发布）
//   - chatu-builder-skill 发布 CI：node_modules/@chatu-ai/app-sdk/dist → chatu-quickstart/references/sdk-api.md（打进 zip）
// 依赖 typescript（SDK 的 devDependency；在 SKILL 仓库 CI 里 npm i --no-save typescript）。
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const [, , dtsDirArg, outArg] = process.argv
if (!dtsDirArg || !outArg) {
  console.error('usage: gen-api-doc.mjs <dts-dir> <out.md>')
  process.exit(2)
}
const dtsDir = resolve(dtsDirArg)
const outFile = resolve(outArg)

/** 模块顺序 = 文档章节顺序；未列出的模块（内部工具）不进文档 */
const MODULES = [
  ['ai', 'ai —— LLM / 向量 / OCR / 生图 / 视频'],
  ['db', 'db —— 集合数据存储'],
  ['kv', 'kv —— 键值缓存'],
  ['storage', 'storage —— 文件存储'],
  ['auth', 'auth —— 登录与用户'],
  ['ratelimit', 'ratelimit —— 限流'],
  ['vector', 'vector —— 向量检索工具函数'],
  ['schema', 'schema —— Standard Schema 校验'],
  ['config', 'config —— 配置'],
  ['errors', 'errors —— 错误类型'],
]

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(dtsDir, '..', 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
})()

const printer = ts.createPrinter({ removeComments: true })
const oneLine = s => s.replace(/\s+/g, ' ').trim()
const cell = s => oneLine(s).replace(/\|/g, '\\|')
const code = s => '`' + cell(s).replace(/`/g, '') + '`'

function jsDocOf(node) {
  const docs = node.jsDoc
  if (!docs || docs.length === 0) return ''
  const d = docs[docs.length - 1]
  const text = typeof d.comment === 'string' ? d.comment : (d.comment ?? []).map(p => p.text ?? '').join('')
  return oneLine(text)
}

function typeText(node, sf) {
  return node ? printer.printNode(ts.EmitHint.Unspecified, node, sf) : 'any'
}

function paramsText(params, sf) {
  return params.map(p => {
    const name = p.name.getText(sf)
    const opt = p.questionToken ? '?' : ''
    return `${name}${opt}: ${typeText(p.type, sf)}`
  }).join(', ')
}

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
}

/** 一个模块的产出：客户端接口方法表、其它接口/类型的字段表、导出函数表 */
function renderModule(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out = []
  const methodsTables = []
  const typeTables = []
  const fnRows = []

  for (const node of sf.statements) {
    if (!isExported(node)) continue

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text
      const doc = jsDocOf(node)
      const methodRows = []
      const fieldRows = []
      for (const m of node.members) {
        const mName = m.name ? m.name.getText(sf) : ''
        const mDoc = jsDocOf(m)
        if (ts.isMethodSignature(m)) {
          methodRows.push([code(`${mName}(${paramsText(m.parameters, sf)})`), code(typeText(m.type, sf)), cell(mDoc)])
        } else if (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type)) {
          methodRows.push([code(`${mName}(${paramsText(m.type.parameters, sf)})`), code(typeText(m.type.type, sf)), cell(mDoc)])
        } else if (ts.isPropertySignature(m)) {
          fieldRows.push([code(mName + (m.questionToken ? '?' : '')), code(typeText(m.type, sf)), cell(mDoc)])
        }
      }
      // 客户端接口（只有方法）单独成"方法"表；其余是选项/结果类型
      if (methodRows.length > 0 && fieldRows.length === 0) {
        methodsTables.push({ name, doc, rows: methodRows })
      } else if (fieldRows.length > 0 || methodRows.length > 0) {
        typeTables.push({ name, doc, rows: [...fieldRows, ...methodRows], generics: node.typeParameters?.map(t => t.getText(sf)).join(', ') })
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text
      const doc = jsDocOf(node)
      // 对象字面量类型按字段展开；其它（联合/映射）给出原文
      if (ts.isTypeLiteralNode(node.type)) {
        const rows = node.type.members.filter(ts.isPropertySignature).map(m =>
          [code(m.name.getText(sf) + (m.questionToken ? '?' : '')), code(typeText(m.type, sf)), cell(jsDocOf(m))])
        typeTables.push({ name, doc, rows })
      } else {
        typeTables.push({ name, doc, alias: typeText(node.type, sf) })
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      fnRows.push([code(`${node.name.text}(${paramsText(node.parameters, sf)})`), code(typeText(node.type, sf)), cell(jsDocOf(node))])
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!d.type) continue
        const name = d.name.getText(sf)
        const doc = jsDocOf(node)
        if (ts.isFunctionTypeNode(d.type)) {
          fnRows.push([code(`${name}(${paramsText(d.type.parameters, sf)})`), code(typeText(d.type.type, sf)), cell(doc)])
        } else {
          fnRows.push([code(name), code(typeText(d.type, sf)), cell(doc)])
        }
      }
    }
  }

  const table = (header, rows) => [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
    '',
  ]

  for (const t of methodsTables) {
    out.push(`### ${t.name}`, '')
    if (t.doc) out.push(t.doc, '')
    out.push(...table(['方法', '返回', '说明'], t.rows))
  }
  if (fnRows.length > 0) {
    out.push('### 导出函数 / 常量', '', ...table(['名称', '类型 / 返回', '说明'], fnRows))
  }
  for (const t of typeTables) {
    out.push(`#### ${t.name}${t.generics ? `<${t.generics}>` : ''}`, '')
    if (t.doc) out.push(t.doc, '')
    if (t.alias) out.push('```ts', `type ${t.name} = ${t.alias}`, '```', '')
    else out.push(...table(['字段', '类型', '说明'], t.rows))
  }
  return out
}

const lines = [
  `# @chatu-ai/app-sdk API 速查${version ? `（v${version}）` : ''}`,
  '',
  '> 本文件由 SDK 的 `.d.ts` 自动生成（`scripts/gen-api-doc.mjs`），**不要手改**；与实际安装的包版本一致。',
  '> 参数以此为准：不确定的参数不传，用默认值；**不要为了探索接口写试探代码或发请求**。',
  '> 用法示例与选型判断见各 SKILL 正文，这里只列签名 / 字段 / 说明。',
  '',
]
const present = new Set(readdirSync(dtsDir).filter(f => f.endsWith('.d.ts') && !f.endsWith('.test.d.ts')).map(f => basename(f, '.d.ts')))
for (const [mod, title] of MODULES) {
  if (!present.has(mod)) continue
  lines.push(`## ${title}`, '', ...renderModule(join(dtsDir, `${mod}.d.ts`)))
}
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'))
console.log(`api doc → ${outFile} (${lines.length} lines)`)
