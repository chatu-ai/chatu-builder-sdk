# 渠道账号模式：登录页（完整代码）

> 由 `chatu-auth` 引用。平台配置 `CHATU_AUTH_MODE=channel` 时用这一套。

登录页只有**账号 + 密码**一步，没有注册入口、没有验证码：

```tsx
// src/app/login/page.tsx
import { redirect } from 'next/navigation';
import { signInWithPassword, currentUser } from '@/lib/platform';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    try {
      // 这里填的就是渠道账号本身，和登录渠道站点时输入的一样；不要加任何前缀
      await signInWithPassword(String(formData.get('account')).trim(), String(formData.get('password')));
    } catch {
      redirect('/login?error=1');
    }
    redirect('/');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">使用渠道账号登录</h1>
      <form action={signIn} className="space-y-3">
        <input name="account" required placeholder="账号" className="w-full rounded-md border px-3 py-2" />
        <input name="password" type="password" required placeholder="密码" className="w-full rounded-md border px-3 py-2" />
        {error ? <p className="text-sm text-destructive">账号或密码不正确</p> : null}
        <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">登录</button>
      </form>
      <p className="text-sm text-muted-foreground">忘记密码请到渠道站点重置；本应用不提供注册。</p>
    </main>
  );
}
```
