/**
 * 应用收款（技术方案 38）：微信支付，**钱直接进应用所有者自己的商户号**，平台只托管回调与记支付单。
 * 只能在服务端调用；商户凭据由用户在「环境变量」面板填（WXPAY_*），应用代码里拿不到也不该拿到。
 *
 * 典型流程：
 * 1. 服务端 `pay.create({ amount, subject })` → 拿 `codeUrl`（PC 扫码）或 `h5Url`（手机浏览器跳转）；
 * 2. 前端展示二维码 / 跳转，并轮询 `pay.getOrder(orderId)`；
 * 3. 状态变 `paid` 再发货/开通权益——**以支付单状态为准**，不要信前端说"付好了"。
 */
import { configVersion, resolveConfig, type PlatformConfig } from './config.js'
import { AppSdkError } from './errors.js'

/** pending = 待支付（含用户正在付）；paid = 已支付；closed = 已关闭/超时/支付失败 */
export type PayOrderStatus = 'pending' | 'paid' | 'closed'

export interface PayOrder {
  orderId: string
  /** 平台生成的商户订单号（微信侧 out_trade_no），对账时用 */
  outTradeNo: string
  /** 你自己的业务单号（下单时传的） */
  bizId: string | null
  /** 金额（**分**） */
  amount: number
  subject: string
  method: 'native' | 'h5'
  status: PayOrderStatus
  /** 微信交易单号；**要退款就拿它到微信支付商户平台操作**（一期没有应用内退款） */
  transactionId: string | null
  paidAt: string | null
  createdAt: string
  expiresAt: string
}

export interface PayCreateOptions {
  /** 金额，单位**分**（19.9 元 = 1990）。必须服务端算出来，别从表单里读 */
  amount: number
  /** 商品/项目名称，进微信账单 */
  subject: string
  /** native = PC 扫码（默认）；h5 = 微信外的手机浏览器 */
  method?: 'native' | 'h5'
  /** 你自己的业务单号（报名 id、订单 id…），之后可用 orders({ bizId }) 回查 */
  bizId?: string
  /** 多久未支付自动关单（秒，默认 900，范围 300–7200） */
  expiresIn?: number
}

export interface PayCreateResult extends PayOrder {
  /** method=native 时有：把它渲染成二维码给用户扫 */
  codeUrl: string | null
  /** method=h5 时有：把用户跳到这个地址 */
  h5Url: string | null
}

export interface PayClient {
  create(options: PayCreateOptions): Promise<PayCreateResult>
  /** 查支付单；还是 pending 时服务端会顺带向微信复核一次，所以回调丢了也能自愈 */
  getOrder(orderId: string): Promise<PayOrder>
  /** 对账 / 后台列表 */
  orders(options?: { status?: PayOrderStatus; bizId?: string; limit?: number; skip?: number }): Promise<{ orders: PayOrder[]; total: number }>
  /** 用户放弃支付时主动关单（不关也会到期自动关） */
  closeOrder(orderId: string): Promise<PayOrder>
}

function platformPay(cfg: PlatformConfig): PayClient {
  const headers = { 'x-api-key': cfg.apiKey, 'x-chatu-env': cfg.env, 'content-type': 'application/json' }
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}/pay${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: any = null
    try { json = await res.json() } catch { /* ignore */ }
    if (!res.ok || json?.ok === false) {
      const err = new AppSdkError(json?.error ?? `HTTP_${res.status}`, json?.message ?? `pay ${method} ${path} failed (${res.status})`, res.status)
      // 未配置商户凭据时把缺的变量名带出来，页面可以直接提示"去环境变量面板填这几个"
      if (json?.missing) err.details = { missing: json.missing }
      throw err
    }
    return json as T
  }
  return {
    async create(options) {
      const r = await call<{ order: PayOrder; codeUrl: string | null; h5Url: string | null }>('POST', '/orders', {
        amount: options.amount, subject: options.subject, method: options.method,
        bizId: options.bizId, expiresIn: options.expiresIn,
      })
      return { ...r.order, codeUrl: r.codeUrl ?? null, h5Url: r.h5Url ?? null }
    },
    async getOrder(orderId) {
      return (await call<{ order: PayOrder }>('GET', `/orders/${encodeURIComponent(orderId)}`)).order
    },
    async orders(options) {
      const q = new URLSearchParams()
      if (options?.status) q.set('status', options.status)
      if (options?.bizId) q.set('bizId', options.bizId)
      if (options?.limit !== undefined) q.set('limit', String(options.limit))
      if (options?.skip !== undefined) q.set('skip', String(options.skip))
      const query = q.toString()
      const r = await call<{ orders: PayOrder[]; total: number }>('GET', `/orders${query ? `?${query}` : ''}`)
      return { orders: r.orders, total: r.total }
    },
    async closeOrder(orderId) {
      return (await call<{ order: PayOrder }>('POST', `/orders/${encodeURIComponent(orderId)}/close`)).order
    },
  }
}

const UNSUPPORTED = '收款只在平台托管模式下可用：需要 CHATU_DATA_URL + CHATU_APP_KEY，并在「环境变量」里配好 WXPAY_* 商户凭据'

function unsupportedPay(): PayClient {
  const fail = (): never => { throw new AppSdkError('PAY_UNSUPPORTED', UNSUPPORTED) }
  return { create: async () => fail(), getOrder: async () => fail(), orders: async () => fail(), closeOrder: async () => fail() }
}

let cached: { key: string; client: PayClient } | null = null

export function getPay(): PayClient {
  const cfg = resolveConfig()
  // sqlite 等驱动只接管 db/kv：有平台配置时收款照常走平台
  const platform = cfg.kind === 'platform' ? cfg : cfg.kind === 'sqlite' ? cfg.platform : null
  // 并入 configure() 次数（与 kv / db / storage / auth 同规则）：换 fetchImpl / 换配置时重建
  const key = `${configVersion()}|` + (platform ? `platform|${platform.baseUrl}|${platform.env}|${platform.apiKey.slice(-4)}` : 'none')
  if (!cached || cached.key !== key) cached = { key, client: platform ? platformPay(platform) : unsupportedPay() }
  return cached.client
}

/** 便捷单例：`import { pay } from '@chatu-ai/app-sdk'` */
export const pay: PayClient = {
  create: (o) => getPay().create(o),
  getOrder: (id) => getPay().getOrder(id),
  orders: (o) => getPay().orders(o),
  closeOrder: (id) => getPay().closeOrder(id),
}
