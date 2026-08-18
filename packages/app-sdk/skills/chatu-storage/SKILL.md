---
name: chatu-storage
description: 平台托管对象存储（@chatu-ai/app-sdk 的 storage）。当应用需要上传/保存/展示文件——图片、头像、附件、音视频、导出的文档——时使用。禁止把文件写进 public/ 或本地文件系统。
---

# 对象存储（storage）

平台托管的对象存储，预览与线上同一套 API。**文件不要写进 `public/` 或 `fs.writeFile`**（重启/部署即丢，也不会同步到线上）。

## API（只能在服务端调用）

```ts
import { storage } from '@/lib/platform';

await storage.put('img/a.png', bytes, { contentType: 'image/png' }); // 服务端直传，≤5MB
const bytes = await storage.get('img/a.png');                         // Uint8Array | null
const src = await storage.url('img/a.png', { expiresIn: 3600 });      // 临时访问地址，给 <img src>
const meta = await storage.head('img/a.png');                          // { key, size, lastModified } | null
const { items, nextCursor } = await storage.list('img/', { limit: 100 });
await storage.delete('img/a.png');
const { url, headers } = await storage.uploadUrl('up/big.mp4', { contentType: 'video/mp4' }); // 大文件预签名直传
```

## 标准写法 A：小文件（≤5MB）走 Server Action

```tsx
// src/app/page.tsx
import { storage } from '@/lib/platform';
import { kv } from '@/lib/platform';
import { revalidatePath } from 'next/cache';

async function upload(formData: FormData) {
  'use server';
  const file = formData.get('file') as File | null;
  if (!file || file.size === 0) return;
  const key = `img/${crypto.randomUUID()}-${file.name}`;
  await storage.put(key, await file.arrayBuffer(), { contentType: file.type });
  await kv.set(`photo:${key}`, { key, name: file.name, size: file.size, at: Date.now() }); // 元数据进 kv，便于列表
  revalidatePath('/');
}

export default async function Page() {
  const { items } = await storage.list('img/');
  const urls = await Promise.all(items.map((i) => storage.url(i.key, { expiresIn: 3600 })));
  return (
    <form action={upload}>
      <input type="file" name="file" accept="image/*" />
      <button type="submit">上传</button>
      {urls.map((u) => <img key={u} src={u} alt="" />)}
    </form>
  );
}
```

## 标准写法 B：大文件走预签名直传（浏览器 → 存储，不经过你的服务端）

```ts
// src/app/api/upload-url/route.ts
import { storage } from '@/lib/platform';

export async function POST(req: Request) {
  const { name, contentType } = await req.json();
  const key = `up/${crypto.randomUUID()}-${name}`;
  const { url, headers } = await storage.uploadUrl(key, { contentType });
  return Response.json({ key, url, headers });
}
```

```ts
// 客户端组件
const { key, url, headers } = await fetch('/api/upload-url', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: file.name, contentType: file.type }),
}).then((r) => r.json());
await fetch(url, { method: 'PUT', body: file, headers });   // 直传
// 传完把 key 交回服务端记录（Server Action 或另一个 API）
```

## 展示图片

`storage.url()` 返回的是**有期限**的地址：在 Server Component 里现取现用，不要把它存进 kv（会过期）。存 `key`，展示时再换地址。

```tsx
const src = await storage.url(photo.key, { expiresIn: 3600 });
<img src={src} alt={photo.name} />
// 需要下载而不是预览：storage.url(key, { downloadName: '报表.xlsx' })
```

Next `<Image>` 组件对临时地址需要额外配置 remotePatterns，简单场景直接用 `<img>`。

## 键名约定

`分类/uuid-原名`，如 `img/…`、`avatar/${userId}.png`、`export/2026-08/report.xlsx`。用前缀分类，方便 `list(前缀)`。

## 边界与禁忌

- **只在服务端**调用；前端只拿 `url()` 的结果或预签名地址。
- `put` 只用于 ≤5MB；更大用 `uploadUrl` 直传。
- 不要 `fs.writeFile` 到项目目录，不要往 `public/` 写运行时文件。
- 不要引入 @aws-sdk/client-s3、cos-nodejs-sdk 等 SDK——`storage` 已是托管服务。
- 列表页大量图片时并发取 url 可能慢，考虑分页或缓存 60s。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 图片 403 / 打不开 | 用了过期的临时地址 | 每次渲染重新 `storage.url()`；不要把地址持久化 |
| 上传大文件超时/失败 | 用了 `put` 走服务端 | 改 `uploadUrl` 预签名直传 |
| 上传后列表看不到 | 没 revalidate | Server Action 里 `revalidatePath()` |
