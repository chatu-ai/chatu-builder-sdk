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
  gitee: {
    id: 'gitee',
    title: '配置 Gitee 登录',
    summary: '用 Gitee（码云）账号登录，国内开发者向工具的首选。个人账号即可创建，无需审核。',
    vars: [
      { name: 'GITEE_CLIENT_ID', label: '第三方应用的 Client ID', secret: false },
      { name: 'GITEE_CLIENT_SECRET', label: '第三方应用的 Client Secret', secret: true },
    ],
    steps: [
      { text: '打开 Gitee → 设置 → 数据管理 → 第三方应用 → 创建应用', href: 'https://gitee.com/oauth/applications' },
      { text: '应用主页填你的应用地址（预览地址即可，之后可改）' },
      { text: '应用回调地址填写下面这个完整地址', copy: '{callbackUrl}' },
      { text: '权限勾选 user_info；创建后把 Client ID 与 Client Secret 填到下方' },
    ],
  },
  qq: {
    id: 'qq',
    title: '配置 QQ 登录',
    summary: '用 QQ 账号登录，适合面向大众的国内应用。需要在 QQ 互联创建「网站应用」并通过审核（个人开发者也可申请）。',
    vars: [
      { name: 'QQ_APP_ID', label: '网站应用的 APP ID', secret: false },
      { name: 'QQ_APP_KEY', label: '网站应用的 APP Key', secret: true },
    ],
    steps: [
      { text: '打开 QQ 互联 → 应用管理 → 创建应用 → 网站应用（首次需完成开发者资质认证）', href: 'https://connect.qq.com/manage.html' },
      { text: '网站地址填你的应用地址，并按页面提示在应用首页放置站点校验（meta 标签或校验文件）——这一步做完可以让 Builder 帮你加到 layout 里' },
      { text: '网站回调域填写下面这个完整地址', copy: '{callbackUrl}' },
      { text: '审核通过后，把 APP ID 与 APP Key 填到下方' },
    ],
    notes: ['QQ 互联的网站应用要人工审核（通常 1–3 个工作日），审核通过前登录会报 redirect uri is illegal。'],
  },
  // 技术方案 34 §3：后台第一个管理员——填进来的邮箱登录后隐式拥有 admin 角色
  admin: {
    id: 'admin',
    title: '设置后台管理员',
    summary: '把你自己的登录邮箱填进来，登录后就能进 /admin 后台；之后可以在后台里给别人授权，不用再改这里。',
    vars: [
      { name: 'ADMIN_EMAILS', label: '管理员邮箱，多个用逗号分隔（用哪个邮箱登录就填哪个）', secret: false },
    ],
    steps: [
      { text: '填你登录这个应用时用的邮箱（不是 ChatU 平台账号），多个管理员用逗号分隔' },
      { text: '保存后用这个邮箱登录应用，就能访问后台了' },
    ],
    notes: ['这里的邮箱只决定"谁是管理员"，不会自动创建账号——还是要先在应用里用这个邮箱登录一次。'],
  },
  // 技术方案 33：不是推荐项——只在用户明确要求"数据放本地 / 用 SQLite"时由 SKILL 发出；缺点必须先讲清
  sqlite: {
    id: 'sqlite',
    title: '改用本地 SQLite 数据库',
    summary: '应用的数据库与 KV 改存到应用目录下的一个 SQLite 文件（默认 ./data/chatu.sqlite），不再使用平台托管的数据库。适合自己用 Docker / 服务器部署、数据量不大的场景。',
    vars: [
      { name: 'CHATU_DATA_DRIVER', label: '填 sqlite（改回平台托管时删掉这个变量即可）', secret: false },
      { name: 'CHATU_SQLITE_PATH', label: '可选，数据库文件路径，默认 ./data/chatu.sqlite', secret: false, required: false },
    ],
    steps: [
      { text: '在下方 CHATU_DATA_DRIVER 里填 sqlite 并保存；代码不用改，重启预览后生效' },
    ],
    notes: [
      '不能一键部署到 EdgeOne Pages / 云函数：它们没有持久磁盘，SQLite 文件每次冷启动都是空的。选了 SQLite 只能用 Docker、自己的服务器或本机运行。',
      '数据跟着文件走：预览期数据在沙箱的 data/ 目录里，不进 Git、不进导出 ZIP、不进部署产物；没有 dev→prod 数据复制、没有发布面板里的数据浏览；备份与迁移要自己做，删除会话或沙箱回收后数据就没了。',
      '只接管数据库与 KV：登录（应用用户）、文件存储、AI 仍然走平台，导出后不配 CHATU_DATA_URL / CHATU_APP_KEY 就没有登录与 AI。',
      '单机单实例，多副本各存各的；沙箱工作区是网络盘，写性能一般，只适合几千到几万条的小数据。',
    ],
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
