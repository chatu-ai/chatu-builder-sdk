# 三方登录：登录页与按钮（完整代码）

> 由 `chatu-auth` 引用。`CHATU_AUTH_MODE=app`（默认）下，在邮箱登录之外加微信扫码 / 微信公众号 H5 / GitHub 登录。
> **前提**：对应环境变量已由用户在 Builder「环境变量」面板配好（先发 ```` ```chatu-env ```` 块，见 SKILL.md）。

## 1. 登录页（Server Component）：按已配置的提供方显示按钮

```tsx
// src/app/login/page.tsx
import { redirect } from 'next/navigation';
import { currentUser, oauthProviders } from '@/lib/platform';
import { OAuthButtons } from './oauth-buttons';

const ERROR_TEXT: Record<string, string> = {
  OAUTH_PROVIDER_DENIED: '已取消授权，可以重新登录',
  OAUTH_NOT_CONFIGURED: '该登录方式还没配置好',
  OAUTH_STATE_INVALID: '登录超时，请重新点击登录',
  OAUTH_TICKET_INVALID: '登录已过期，请重新点击登录',
  OAUTH_EXCHANGE_FAILED: '登录服务暂时不可用，请稍后再试',
  USER_DISABLED: '账号已被停用',
};

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; missing?: string; returnTo?: string }> }) {
  if (await currentUser()) redirect('/');
  const { error, missing, returnTo } = await searchParams;
  const { providers } = await oauthProviders();
  const enabled = providers.filter(p => p.configured).map(p => p.provider);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">登录</h1>
      {error ? (
        <p className="text-sm text-destructive">
          {ERROR_TEXT[error] ?? '登录失败，请重试'}
          {missing ? `（缺少环境变量：${missing}）` : null}
        </p>
      ) : null}
      <OAuthButtons enabled={enabled} returnTo={returnTo ?? '/'} />
      {/* 下面可以接着放邮箱验证码表单（见 login-app.md） */}
    </main>
  );
}
```

`enabled` 为空时说明一个提供方都没配，不要渲染按钮——此时要回到 SKILL 的「第一步」发 ```` ```chatu-env ```` 块。

## 2. 按钮（Client Component）：点击时同步调 `startOAuth`

```tsx
// src/app/login/oauth-buttons.tsx
'use client';
import { useState } from 'react';
import { startOAuth, pickWeChatProvider } from '@chatu-ai/app-sdk/browser';

export function OAuthButtons({ enabled, returnTo }: { enabled: string[]; returnTo: string }) {
  const [error, setError] = useState<string | null>(null);
  // 微信：在微信内用公众号 H5，否则用扫码；只配了一种时就用配了的那种
  const wechat = pickWeChatProvider();
  const wechatProvider = enabled.includes(wechat) ? wechat
    : enabled.includes('wechat') ? 'wechat'
    : enabled.includes('wechat-mp') ? 'wechat-mp' : null;

  async function go(provider: string) {
    setError(null);
    const r = await startOAuth(provider, { returnTo });   // 弹窗模式下这里会等结果；跳转模式立即返回
    if (!r.ok) setError(r.error === 'OAUTH_POPUP_CLOSED' ? '登录窗口已关闭' : '登录失败，请重试');
  }

  if (!wechatProvider && !enabled.includes('github')) return null;
  return (
    <div className="space-y-2">
      {wechatProvider ? (
        <button type="button" onClick={() => go(wechatProvider)}
          className="w-full rounded-md bg-[#07C160] px-3 py-2 text-white">
          微信登录
        </button>
      ) : null}
      {enabled.includes('github') ? (
        <button type="button" onClick={() => go('github')}
          className="w-full rounded-md border px-3 py-2">
          使用 GitHub 登录
        </button>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
```

要点：

- `startOAuth` **必须在点击事件里同步调用**，不要包在 `setTimeout` / 先 `await` 别的请求之后再调（弹窗会被浏览器拦截）。
- 不要传 `mode`，缺省 `auto` 会在 Builder 预览（iframe）里用弹窗、线上整页跳转。
- 公众号 H5 只能在微信里打开：`wechatProvider === 'wechat-mp'` 而当前不在微信内时（`isWeChatBrowser()` 为 false），可以把按钮文案改成"请在微信中打开后登录"。

## 3. 登录后的用户

```ts
const me = await requireUser();
me.source;    // 'wechat' | 'wechat-mp' | 'github' | undefined（邮箱用户）
me.email;     // 微信用户为 null，GitHub 用户为其主邮箱（可能也为 null）
me.username;  // GitHub 登录名；微信没有
me.meta.oauth // { wechat: { openid, unionid?, ... } } 之类的提供方资料，只读
```

统一用 `me.id` 关联业务数据；显示名用 `me.name ?? me.username ?? '用户'`。

## 4. 老工作区补齐路由（模板已内置，缺失时才需要）

```ts
// src/app/api/auth/oauth/[provider]/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { AppSdkError, oauthStartUrl } from '@/lib/platform';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const returnTo = url.searchParams.get('returnTo');
  const mode = url.searchParams.get('mode') === 'popup' ? 'popup' : 'redirect';
  try {
    const target = await oauthStartUrl(provider, { origin: url.origin, returnTo, mode });
    return NextResponse.redirect(target, 302);
  } catch (err) {
    const code = err instanceof AppSdkError ? err.code : 'OAUTH_START_FAILED';
    const missing = err instanceof AppSdkError ? (err.details?.missing as string[] | undefined) : undefined;
    const back = new URL('/login', url.origin);
    back.searchParams.set('error', code);
    if (missing?.length) back.searchParams.set('missing', missing.join(','));
    return NextResponse.redirect(back, 302);
  }
}
```

```ts
// src/app/api/auth/oauth/callback/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { AppSdkError, signInWithOAuthTicket } from '@/lib/platform';

export const dynamic = 'force-dynamic';

function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const ticket = url.searchParams.get('ticket');
  const error = url.searchParams.get('error');
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const back = new URL('/login', url.origin);
  if (!ticket) {
    back.searchParams.set('error', error ?? 'OAUTH_PROVIDER_DENIED');
    return NextResponse.redirect(back, 302);
  }
  try {
    await signInWithOAuthTicket(ticket);
    return NextResponse.redirect(new URL(returnTo, url.origin), 302);
  } catch (err) {
    back.searchParams.set('error', err instanceof AppSdkError ? err.code : 'OAUTH_EXCHANGE_FAILED');
    return NextResponse.redirect(back, 302);
  }
}
```

`src/lib/platform/auth.ts` 里若没有 `oauthStartUrl` / `signInWithOAuthTicket` / `oauthProviders`，说明工作区的 app-sdk 与模板都太旧——先让平台恢复工作区（会自动对齐 SDK 与模板），不要手写这三个函数。
