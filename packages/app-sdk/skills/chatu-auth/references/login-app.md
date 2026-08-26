# 应用自建用户：登录页与退出登录（完整代码）

> 由 `chatu-auth` 引用。模式为默认的 `CHATU_AUTH_MODE=app` 时用这一套。

```tsx
// src/app/login/page.tsx
import { redirect } from 'next/navigation';
import { sendLoginCode, signInWithCode, currentUser } from '@/lib/platform';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ email?: string; error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { email, error } = await searchParams;

  async function send(formData: FormData) {
    'use server';
    const value = String(formData.get('email') ?? '').trim();
    if (!value) return;
    await sendLoginCode(value);
    redirect(`/login?email=${encodeURIComponent(value)}`);
  }

  async function verify(formData: FormData) {
    'use server';
    try {
      await signInWithCode(String(formData.get('email')), String(formData.get('code')));
    } catch {
      redirect(`/login?email=${encodeURIComponent(String(formData.get('email')))}&error=1`);
    }
    redirect('/');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      {!email ? (
        <form action={send} className="space-y-3">
          <input name="email" type="email" required placeholder="邮箱" className="w-full rounded-md border px-3 py-2" />
          <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">发送验证码</button>
        </form>
      ) : (
        <form action={verify} className="space-y-3">
          <input type="hidden" name="email" value={email} />
          <p className="text-sm text-muted-foreground">验证码已发送至 {email}</p>
          {error ? <p className="text-sm text-destructive">验证码不正确或已过期</p> : null}
          <input name="code" inputMode="numeric" required placeholder="6 位验证码" className="w-full rounded-md border px-3 py-2" />
          <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">登录</button>
        </form>
      )}
    </main>
  );
}
```

退出登录：

```tsx
import { endSession } from '@/lib/platform';
import { redirect } from 'next/navigation';

export function SignOutButton() {
  async function out() {
    'use server';
    await endSession();
    redirect('/login');
  }
  return <form action={out}><button className="text-sm underline">退出登录</button></form>;
}
```
