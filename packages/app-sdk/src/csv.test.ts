import { describe as d, expect, it } from 'vitest'
import { parseCsv, toCsv } from './index'

d('toCsv', () => {
  const rows = [
    { _id: 'a1', title: '买,牛奶', done: false, tags: ['家务'], owner: { name: '张三' }, note: null },
    { _id: 'a2', title: '写"周报"', done: true, tags: [], owner: { name: '李四' }, extra: 1 },
  ]

  it('默认带 BOM、列取所有行出现过的字段、CRLF 换行', () => {
    const csv = toCsv(rows)
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe('_id,title,done,tags,owner,note,extra')
    expect(lines).toHaveLength(3)
  })

  it('转义：逗号/引号/换行加引号，引号翻倍；对象数组转 JSON；null 空串', () => {
    const [, first, second] = toCsv(rows, { bom: false }).split('\r\n')
    expect(first).toContain('"买,牛奶"')
    expect(first).toContain('"[""家务""]"')   // JSON 里有引号 → 整格加引号并把引号翻倍
    expect(first!.endsWith(',,')).toBe(true) // note=null、extra 缺失
    expect(second).toContain('"写""周报"""')
    expect(toCsv([{ a: 'x\ny' }], { bom: false }).split('\r\n')[1]).toBe('"x\ny"')
  })

  it('columns 指定列、表头与格式化函数；header:false 不输出表头', () => {
    const csv = toCsv(rows, {
      bom: false,
      columns: ['title', { key: 'owner.name', label: '负责人' }, { key: 'done', label: '状态', value: r => (r.done ? '已完成' : '待办') }],
    })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('title,负责人,状态')
    expect(lines[1]).toBe('"买,牛奶",张三,待办')
    expect(toCsv(rows, { bom: false, header: false, columns: ['title'] }).split('\r\n')).toHaveLength(2)
  })

  it('空数组只有表头（或空串）；分隔符可换', () => {
    expect(toCsv([], { bom: false })).toBe('')
    expect(toCsv(rows, { bom: false, delimiter: ';', columns: ['title'] }).split('\r\n')[1]).toBe('买,牛奶')
  })
})

d('parseCsv', () => {
  it('表头 + 行对象，忽略 BOM / CRLF / 空行', () => {
    const { header, rows } = parseCsv('﻿name,qty\r\n苹果,3\r\n\r\n香蕉,5\r\n')
    expect(header).toEqual(['name', 'qty'])
    expect(rows).toEqual([{ name: '苹果', qty: '3' }, { name: '香蕉', qty: '5' }])
  })

  it('引号内的逗号、换行与转义引号', () => {
    const { rows } = parseCsv('name,note\n"买,牛奶","第一行\n第二行"\n"他说""好"",ok"')
    expect(rows[0]).toEqual({ name: '买,牛奶', note: '第一行\n第二行' })
    expect(rows[1]!.name).toBe('他说"好",ok')
  })

  it('缺列补空串、多余列丢弃、值两端空白去掉', () => {
    const { rows } = parseCsv('a,b,c\n 1 ,2\n1,2,3,4')
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' })
    expect(rows[1]).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('与 toCsv 往返一致', () => {
    const src = [{ name: '张三, Jr.', note: '带"引号"\n和换行' }]
    const { rows } = parseCsv(toCsv(src))
    expect(rows).toEqual(src.map(r => ({ ...r })))
  })
})
