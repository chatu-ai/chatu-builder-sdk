/**
 * 浏览器端小工具：`import { startOAuth, isWeChatBrowser } from '@chatu-ai/app-sdk/browser'`
 * 只做跳转/弹窗与消息接收，不碰任何密钥；服务端逻辑在 auth.oauth.*（技术方案 32 §4.2）。
 *
 * 约定的应用路由（模板已内置）：
 * - GET /api/auth/oauth/[provider]?returnTo=&mode=   → 服务端 auth.oauth.start() 后 302 到提供方
 * - GET /api/auth/oauth/callback?ticket=&returnTo=    → 服务端 auth.oauth.exchange() 写 cookie 后 302 到 returnTo
 */
import type { OAuthProvider } from './auth.js'

export interface StartOAuthOptions {
  /** 登录后回到的站内路径，缺省当前路径 */
  returnTo?: string
  /**
   * redirect（整页跳转）| popup（弹窗）| auto（缺省：在 iframe 里用 popup，否则 redirect）。
   * Builder 预览是 iframe，提供方授权页禁止被嵌入，所以预览里必须走 popup。
   */
  mode?: 'redirect' | 'popup' | 'auto'
  /** 应用的发起路由前缀，缺省 /api/auth/oauth */
  basePath?: string
  /** 弹窗尺寸 */
  popup?: { width?: number; height?: number }
}

/** 是否在微信内置浏览器里（决定用 wechat-mp 还是 wechat） */
export function isWeChatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /MicroMessenger/i.test(navigator.userAgent)
}

/** 当前页面是否被嵌在 iframe 里（Builder 预览就是） */
export function isInIframe(): boolean {
  if (typeof window === 'undefined') return false
  try { return window.self !== window.top } catch { return true }
}

/** 按运行环境挑微信登录方式：微信内 → 公众号 H5，否则 → 扫码 */
export function pickWeChatProvider(): 'wechat' | 'wechat-mp' {
  return isWeChatBrowser() ? 'wechat-mp' : 'wechat'
}

/**
 * 发起三方登录。**必须在用户点击事件里同步调用**（弹窗模式受浏览器拦截策略限制）。
 * redirect 模式：整页跳到发起路由；popup 模式：弹窗打开发起路由，等回调页 postMessage 回 ticket，
 * 再把当前页跳到回调路由完成写 cookie 与回跳。返回的 Promise 在 popup 模式下于收到结果（或弹窗被关闭）时完成。
 */
export function startOAuth(provider: OAuthProvider, opts: StartOAuthOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const basePath = (opts.basePath ?? '/api/auth/oauth').replace(/\/$/, '')
  const returnTo = opts.returnTo ?? (typeof location !== 'undefined' ? location.pathname + location.search : '/')
  const mode = opts.mode === 'auto' || !opts.mode ? (isInIframe() ? 'popup' : 'redirect') : opts.mode
  const startUrl = `${basePath}/${encodeURIComponent(provider)}?returnTo=${encodeURIComponent(returnTo)}&mode=${mode}`
  const callbackPath = `${basePath}/callback`

  if (mode === 'redirect') {
    location.assign(startUrl)
    return Promise.resolve({ ok: true })
  }

  const width = opts.popup?.width ?? 520
  const height = opts.popup?.height ?? 640
  const left = Math.max(0, (screen.width - width) / 2)
  const top = Math.max(0, (screen.height - height) / 2)
  const win = window.open(startUrl, 'chatu-oauth', `popup=yes,width=${width},height=${height},left=${left},top=${top}`)
  if (!win) {
    // 弹窗被拦截：退化为整页跳转
    location.assign(startUrl)
    return Promise.resolve({ ok: true })
  }

  return new Promise(resolve => {
    let settled = false
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(timer)
      resolve(result)
    }
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== location.origin) return
      const data = ev.data
      if (!data || data.type !== 'chatu-oauth') return
      try { win.close() } catch { /* ignore */ }
      if (data.ticket) {
        const q = new URLSearchParams({ ticket: String(data.ticket) })
        if (typeof data.returnTo === 'string' && data.returnTo) q.set('returnTo', data.returnTo)
        finish({ ok: true })
        location.assign(`${callbackPath}?${q.toString()}`)
      } else {
        finish({ ok: false, error: typeof data.error === 'string' ? data.error : 'OAUTH_EXCHANGE_FAILED' })
      }
    }
    window.addEventListener('message', onMessage)
    // 用户直接关掉弹窗
    const timer = setInterval(() => {
      if (win.closed) finish({ ok: false, error: 'OAUTH_POPUP_CLOSED' })
    }, 500)
  })
}
