---
name: chatu-pay
description: 应用收款（@chatu-ai/app-sdk 的 pay）：微信支付 Native（PC 扫码）与 H5（手机浏览器）。当应用要收钱——报名费、课程、会员、小店、预约定金——或用户说"要能付款/收款/在线支付"时使用。钱**直接进用户自己的微信支付商户号**，平台不经手；需要企业或个体工商户营业执照，个人自然人办不了商户号。含资质引导（```chatu-env 块）、下单与轮询的标准写法、金额与幂等的硬规则。禁止引入 wechatpay-node-v3 等支付 SDK、禁止自己拼签名、禁止把商户私钥放进代码或前端。
---

# 应用收款（pay）

给**生成出来的这个应用**收钱的能力。钱直接进**应用所有者自己的微信支付商户号**，平台只负责托管回调、记一份支付单——平台不碰交易资金（法规红线，见「边界与禁忌」）。

## 第一步：先说资质，别让用户白忙

用户一提"要收款"，**先讲清楚这三件事**，确认了再动手：

> 接微信支付需要你自己的**商户号**，钱直接进你的账户，我们不经手。三个前提：
> ① 需要**企业或个体工商户的营业执照**——个人自然人开不了微信支付商户号（审核通常 1–2 个工作日）；
> ② 微信支付**没有测试环境**，预览期下单也是真钱，我们用 1 分钱测；
> ③ 这一版**没有应用内退款**，要退款你到微信支付商户平台按订单号操作（后台订单列表里会显示微信交易单号）。
> 确认要接吗？

没有营业执照的用户：如实告诉他这条路现在走不通（支付宝个人当面付的方案还没上），**不要**给他做个假的付款按钮。

## 第二步：要凭据

看工作区 `.chatu/env-names.json`，缺 `WXPAY_*` 就发块并**停下**等用户配置：

````md
好的，先配微信支付商户凭据，配好我再接下单流程：

```chatu-env
{ "preset": "wxpay", "vars": ["WXPAY_MCH_ID", "WXPAY_APP_ID", "WXPAY_API_V3_KEY", "WXPAY_CERT_SERIAL", "WXPAY_PRIVATE_KEY"], "resume": "微信支付凭据配好了，请继续" }
```
````

卡片会带出"去哪里拿这五个值"的步骤。**回调地址由平台托管**，用户不需要在商户平台里配任何回调 URL。

## API（只能在服务端调用）

```ts
import { pay } from '@/lib/platform';

// 下单：amount 单位是**分**（19.9 元 = 1990），必须服务端算出来
const order = await pay.create({
  amount: 1990,
  subject: '周末营地报名',          // 进微信账单的标题
  method: 'native',                 // native = PC 扫码（默认）；h5 = 微信外手机浏览器
  bizId: signup._id,                // 你自己的业务单号，回查用
});
// → { orderId, outTradeNo, status: 'pending', codeUrl, h5Url, expiresAt, ... }

const o = await pay.getOrder(order.orderId);    // pending | paid | closed
const { orders, total } = await pay.orders({ status: 'paid', limit: 50 });   // 对账/后台
await pay.closeOrder(order.orderId);            // 用户放弃支付
```

## 标准写法：下单 → 扫码 → 轮询 → 发货

```ts
// src/app/signup/actions.ts
'use server';
import { db, pay } from '@/lib/platform';

export async function createSignupOrder(formData: FormData) {
  const signup = await db.collection('signups').insert({
    name: String(formData.get('name') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    status: 'unpaid',
  });
  // ✅ 价格从服务端的配置/商品表里取，绝不从 formData 读
  const price = 1990;
  const order = await pay.create({ amount: price, subject: '周末营地报名', bizId: signup._id });
  return { orderId: order.orderId, codeUrl: order.codeUrl, signupId: signup._id };
}

// 轮询用：只认支付单状态，顺便把业务记录改成已付
export async function checkOrder(orderId: string, signupId: string) {
  const o = await pay.getOrder(orderId);
  if (o.status === 'paid') {
    await db.collection('signups').updateIf(signupId, { set: { status: 'paid', paidAt: Date.now() } }, { status: 'unpaid' });
  }
  return o.status;
}
```

二维码：`codeUrl` 是 `weixin://wxpay/bizpayurl?...`，要渲染成二维码才能扫。**允许为此装 `qrcode`**（很小）：

```ts
import QRCode from 'qrcode';
const qrDataUrl = await QRCode.toDataURL(order.codeUrl!, { width: 240 });   // <img src={qrDataUrl} />
```

前端每 2–3 秒调一次 `checkOrder`，`paid` 就跳成功页；超过 `expiresAt` 提示"二维码已过期，重新下单"。手机端（微信外浏览器）用 `method: 'h5'`，拿 `h5Url` 直接 `location.href` 跳过去。

## 硬规则（错一条就是资损）

1. **金额服务端算**：`amount` 只能来自服务端的商品/报名项配置，**绝不**从表单、query、请求体里读——否则用户改成 1 分就能报名。
2. **单位是分**：19.9 元写 `1990`。写成 `19.9` 会被服务端拒（`INVALID_AMOUNT`），写成 `199000` 就是多收 100 倍。
3. **以支付单状态为准**：前端说"付好了"不算数，永远 `pay.getOrder()` 查；发货/开通权益只在 `status === 'paid'` 时做。
4. **发货要幂等**：用 `updateIf(id, {...}, { status: 'unpaid' })` 或 `kv.setnx` 保证同一单只发一次（见 `chatu-db` 的「并发与唯一性」）。
5. **一个业务单一个支付单**：用户重复点"去支付"时，先查 `pay.orders({ bizId })` 里有没有还 pending 的单，有就复用，别每点一次建一单。
6. **不做退款 UI**：这一版没有应用内退款，别做"申请退款"按钮；要退引导到商户平台（后台列表显示 `transactionId`）。

## 后台订单列表

配合 `chatu-admin`（`/admin` 守卫）做一页：`pay.orders({ status, limit, skip })` 列出订单，显示**微信交易单号 `transactionId`**——所有者要退款、要对账全靠它。导出 CSV 见 `chatu-admin/references/export-import.md`。

## 边界与禁忌

- **只在服务端**调用；`codeUrl` / `h5Url` 可以给前端，商户凭据永远不行。
- 不要 `npm i wechatpay-node-v3 / wechatpay-axios-plugin / alipay-sdk`，不要自己拼签名验签、不要自己写回调路由——回调在平台，应用侧根本收不到微信的通知。
- 不要把商户私钥、APIv3 密钥写进代码、`.env` 文件或前端；它们只存在「环境变量」面板里。
- **不要做"平台代收再转账给商家"**这类多商户资金归集——那是无证经营支付业务（二清），违法。一个应用只收到它自己所有者的商户号里。
- 不要承诺"担保交易""确认收货后打款"——需要资金沉淀，同上。
- 预览环境（dev）与线上（prod）的支付单是分开的，但**用的是同一个真商户号**：预览期测试请用 1 分钱。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `PAY_NOT_CONFIGURED` | 商户凭据没配齐 | 看 `details.missing` 列出的变量名，发 `chatu-env` 卡片让用户补 |
| `PAY_UNSUPPORTED` | 应用跑在没有平台数据的环境（本地/EdgeOne 存储驱动） | 收款必须走平台托管模式 |
| `INVALID_AMOUNT` | 金额不是正整数分，或超过 10 万元 | 单位是分；大额交易请用户自行评估风控 |
| `WXPAY_CREATE_FAILED` + 微信错误码 | 商户号没开通 Native/H5、AppID 与商户号未绑定、证书序列号或私钥不对 | 把微信返回的 message 原样转述给用户，让他到商户平台核对 |
| 扫码后一直 pending | 用户没付完，或回调延迟 | 继续轮询；服务端每次查单都会向微信复核，回调丢了也能自愈 |
| 用户付了钱但没开通权益 | 发货逻辑写在前端，或没有幂等 | 发货放服务端，条件是 `pay.getOrder()` 返回 paid |
| 重复下单一堆 pending 单 | 每次点按钮都 `pay.create` | 先查 `pay.orders({ bizId })` 复用未过期的 pending 单 |
