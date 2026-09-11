import { describe as d, expect, it } from 'vitest'
import { configure, pay } from './index'

// 应用收款（技术方案 38）：钱直达所有者自己的商户号，SDK 只是薄封装
function stub(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
    return handler(String(url), init)
  }) as unknown as typeof fetch
  configure({ driver: 'platform', baseUrl: 'https://api.test/data/v1/', apiKey: 'sk-conv-abc', env: 'prod', fetchImpl })
  return calls
}

const ORDER = {
  orderId: 'o1', outTradeNo: 'ab12cd34ff', bizId: 'signup-9', amount: 1990, subject: '周末营地报名',
  method: 'native', status: 'pending', transactionId: null, paidAt: null,
  createdAt: '2026-09-11T00:00:00Z', expiresAt: '2026-09-11T00:15:00Z',
}

d('pay', () => {
  it('create：POST /pay/orders，把 codeUrl 与订单一起返回', async () => {
    const calls = stub(() => new Response(JSON.stringify({ ok: true, order: ORDER, codeUrl: 'weixin://wxpay/bizpayurl?pr=x', h5Url: null }), { status: 200 }))
    const r = await pay.create({ amount: 1990, subject: '周末营地报名', bizId: 'signup-9' })
    expect(calls[0]!.url).toBe('https://api.test/data/v1/pay/orders')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ amount: 1990, subject: '周末营地报名', method: undefined, bizId: 'signup-9', expiresIn: undefined })
    expect(r.orderId).toBe('o1')
    expect(r.status).toBe('pending')
    expect(r.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=x')
    expect(r.h5Url).toBeNull()
  })

  it('getOrder / closeOrder / orders 的路径与返回', async () => {
    const paid = { ...ORDER, status: 'paid', transactionId: '4200001', paidAt: '2026-09-11T00:03:00Z' }
    const calls = stub((url) => {
      if (url.includes('/close')) return new Response(JSON.stringify({ ok: true, order: { ...ORDER, status: 'closed' } }), { status: 200 })
      if (url.includes('/orders/o1')) return new Response(JSON.stringify({ ok: true, order: paid }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, orders: [paid], total: 1 }), { status: 200 })
    })
    expect((await pay.getOrder('o1')).status).toBe('paid')
    expect((await pay.getOrder('o1')).transactionId).toBe('4200001')
    expect((await pay.closeOrder('o1')).status).toBe('closed')
    const list = await pay.orders({ status: 'paid', bizId: 'signup-9', limit: 20 })
    expect(list.total).toBe(1)
    expect(calls.at(-1)!.url).toBe('https://api.test/data/v1/pay/orders?status=paid&bizId=signup-9&limit=20')
  })

  it('未配置商户凭据：PAY_NOT_CONFIGURED 带出缺哪几个变量', async () => {
    stub(() => new Response(JSON.stringify({ ok: false, error: 'PAY_NOT_CONFIGURED', missing: ['WXPAY_MCH_ID', 'WXPAY_PRIVATE_KEY'] }), { status: 400 }))
    await expect(pay.create({ amount: 1, subject: 'x' })).rejects.toMatchObject({
      code: 'PAY_NOT_CONFIGURED',
      details: { missing: ['WXPAY_MCH_ID', 'WXPAY_PRIVATE_KEY'] },
    })
  })

  it('金额写错（把分写成元）由服务端挡：INVALID_AMOUNT 原样抛出', async () => {
    stub(() => new Response(JSON.stringify({ ok: false, error: 'INVALID_AMOUNT', message: 'amount 是分' }), { status: 400 }))
    await expect(pay.create({ amount: 99999999, subject: 'x' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', status: 400 })
  })

  it('没有平台配置时报 PAY_UNSUPPORTED', async () => {
    configure({ driver: 'memory' })
    await expect(pay.create({ amount: 1, subject: 'x' })).rejects.toMatchObject({ code: 'PAY_UNSUPPORTED' })
    await expect(pay.orders()).rejects.toMatchObject({ code: 'PAY_UNSUPPORTED' })
  })
})
