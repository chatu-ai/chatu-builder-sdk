/**
 * 环境变量引导预设（技术方案 32 §4.4）—— 单一事实源。
 * 前端 EnvRequestCard 按 preset 带出「去哪个后台、填什么回调域、拿哪几个值」的步骤；
 * SKILL 里模型发出的 ```chatu-env 块只需写 preset + vars，说明文案不用模型自己编。
 * 文案里的 {callbackDomain} / {callbackUrl} 由前端用平台实际回调域替换（来自 GET /data/v1/auth/oauth/providers 或前端配置）。
 */
import type { EnvRequestVar } from './events'

export interface EnvPresetStep {
  /** 一句话步骤，可含 {callbackDomain} / {callbackUrl} 占位 */
  text: string
  /** 可点开的外链（提供方后台） */
  href?: string
  /** 需要用户复制的值（如回调域），前端渲染成带复制按钮的代码片 */
  copy?: string
}

export interface EnvPreset {
  id: string
  title: string
  /** 一句话说明适用场景，帮用户确认选对了 */
  summary: string
  vars: EnvRequestVar[]
  steps: EnvPresetStep[]
  /** 预览环境的已知限制（如微信 H5 只能在微信内打开） */
  notes?: string[]
}

export const ENV_PRESETS: Record<string, EnvPreset> = {
  wechat: {
    id: 'wechat',
    title: '配置微信扫码登录',
    summary: 'PC 浏览器里弹出二维码，用微信扫码登录。需要微信开放平台的「网站应用」（企业主体，需审核）。',
    vars: [
      { name: 'WECHAT_APP_ID', label: '开放平台网站应用的 AppID', secret: false },
      { name: 'WECHAT_APP_SECRET', label: '开放平台网站应用的 AppSecret', secret: true },
    ],
    steps: [
      { text: '打开微信开放平台 → 管理中心 → 网站应用，创建或选择一个已通过审核的应用', href: 'https://open.weixin.qq.com/' },
      { text: '在应用详情的「授权回调域」填写下面的域名（只填域名，不带 https:// 和路径）', copy: '{callbackDomain}' },
      { text: '复制该应用的 AppID 与 AppSecret，填到下方对应的变量里' },
    ],
    notes: ['扫码登录只能在 PC 浏览器里用；微信内打开请改用「公众号 H5 登录」（wechat-mp）。'],
  },
  'wechat-mp': {
    id: 'wechat-mp',
    title: '配置微信公众号 H5 登录',
    summary: '在微信内打开应用时静默/授权登录。需要已认证的服务号（订阅号没有网页授权权限）。',
    vars: [
      { name: 'WECHAT_MP_APP_ID', label: '公众号的 AppID（开发 → 基本配置）', secret: false },
      { name: 'WECHAT_MP_APP_SECRET', label: '公众号的 AppSecret（开发 → 基本配置）', secret: true },
    ],
    steps: [
      { text: '登录微信公众平台 → 设置与开发 → 公众号设置 → 功能设置 → 网页授权域名', href: 'https://mp.weixin.qq.com/' },
      { text: '域名填写下面这个（平台已托管校验文件 MP_verify_xxx.txt，不需要你上传）', copy: '{callbackDomain}' },
      { text: '到 开发 → 基本配置 复制 AppID 与 AppSecret（AppSecret 只显示一次，重置后旧值失效）' },
      { text: '如果要在微信里预览调试，还需在 开发 → 开发者工具 → 网页开发者工具 里绑定你的微信号' },
    ],
    notes: ['公众号授权链接只能在微信内打开；在 PC 浏览器里请用「微信扫码登录」（wechat）。'],
  },
  github: {
    id: 'github',
    title: '配置 GitHub 登录',
    summary: '用 GitHub 账号登录，适合开发者向的工具类应用。个人账号即可创建，无需审核。',
    vars: [
      { name: 'GITHUB_CLIENT_ID', label: 'OAuth App 的 Client ID', secret: false },
      { name: 'GITHUB_CLIENT_SECRET', label: 'OAuth App 的 Client secret', secret: true },
    ],
    steps: [
      { text: '打开 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App', href: 'https://github.com/settings/developers' },
      { text: 'Homepage URL 填你的应用地址（预览地址即可，之后可改）' },
      { text: 'Authorization callback URL 填写下面这个完整地址', copy: '{callbackUrl}' },
      { text: '创建后点 Generate a new client secret，把 Client ID 与 Client secret 填到下方' },
    ],
    notes: ['国内访问 GitHub 偶尔不稳定，登录失败时让用户重试即可。'],
  },
}

export function getEnvPreset(id: string | undefined | null): EnvPreset | undefined {
  return id ? ENV_PRESETS[id] : undefined
}

/** 缺省的密钥判断：名字里带 SECRET / KEY / TOKEN / PASSWORD 视为密钥 */
export function isSecretEnvName(name: string): boolean {
  return /SECRET|KEY|TOKEN|PASSWORD|PASS$/i.test(name)
}

/** 把步骤文案里的占位替换为实际回调域/回调地址 */
export function fillEnvPresetText(text: string, ctx: { callbackDomain?: string | null; callbackUrl?: string | null }): string {
  return text
    .replace(/\{callbackDomain\}/g, ctx.callbackDomain ?? '（平台回调域，见「环境变量」面板）')
    .replace(/\{callbackUrl\}/g, ctx.callbackUrl ?? '（平台回调地址，见「环境变量」面板）')
}
