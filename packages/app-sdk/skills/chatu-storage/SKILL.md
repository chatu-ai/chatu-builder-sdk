---
name: chatu-storage
description: 平台托管对象存储（@chatu-ai/app-sdk 的 storage），含图片缩略图（thumbnail）。当应用需要上传/保存/展示文件——图片、头像、附件、音视频、导出的文档——时使用。禁止把文件写进 public/ 或本地文件系统。
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

## 缩略图（列表页、头像必须用）

原图是用户手机拍的，动辄 3–8MB。列表页挂 20 张原图 = 上百 MB 流量 + 首屏白屏，而且按下载字节计费。**凡是缩略展示，一律用 `storage.thumbnail()`**：

```tsx
// 方形卡片/头像：裁切填满
const src = await storage.thumbnail(photo.key, { width: 320, height: 320 });          // fit 默认 cover
// 详情页大图：保持比例，限制最长边
const big = await storage.thumbnail(photo.key, { width: 1200, fit: 'contain' });
<img src={src} alt={photo.name} loading="lazy" />
```

- 第一次调用才真的缩放（读原图 → 缩 → 写回存储），之后同一规格直接返回地址，**规格越少缓存命中率越高**：整站统一用两三种尺寸，别每个页面写不同的宽高。
- 参数：`width` / `height` 至少给一个（≤2048，只给一边按比例算另一边）、`fit`（`cover` 裁切填满 / `contain` 完整装下）、`format`（默认 `webp`，要兼容极老环境用 `jpeg`）。
- **上传成功后顺手生成一次**（在写库的那个 Server Action 里 `await storage.thumbnail(key, {width:320,height:320})`），别把首次生成的耗时留给列表页首屏。
- 缩略图会占存储空间并计入用量——这是"用空间换流量"，值得，但别为一张图生成十种规格。
- **覆盖同名原图后缩略图不会自动更新**：上传一律用新 key（`img/${crypto.randomUUID()}-${文件名}`）；确实要覆盖就传 `refresh: true` 重算一次。
- 只有平台托管的存储会真缩放；EdgeOne 存储 / 本地降级会返回原图地址（页面照常显示，只是没变小）。
- 缩略图存在 `_thumb/` 前缀下，**不要**自己往这个前缀写东西，也不要对缩略图的 key 再生成缩略图。

## 键名约定

`分类/uuid-原名`，如 `img/…`、`avatar/${userId}.png`、`export/2026-08/report.xlsx`。用前缀分类，方便 `list(前缀)`。

## 边界与禁忌

- **只在服务端**调用；前端只拿 `url()` 的结果或预签名地址。
- `put` 只用于 ≤5MB；更大用 `uploadUrl` 直传。
- 不要 `fs.writeFile` 到项目目录，不要往 `public/` 写运行时文件。
- 不要引入 @aws-sdk/client-s3、cos-nodejs-sdk 等 SDK——`storage` 已是托管服务。
- 列表页大量图片时并发取 url 可能慢，考虑分页或缓存 60s。
- 列表/头像**不要挂原图**，用 `storage.thumbnail()`（见上）；原图只在详情页或下载时给。

## 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 图片 403 / 打不开 | 用了过期的临时地址 | 每次渲染重新 `storage.url()`；不要把地址持久化 |
| 上传大文件超时/失败 | 用了 `put` 走服务端 | 改 `uploadUrl` 预签名直传 |
| 上传后列表看不到 | 没 revalidate | Server Action 里 `revalidatePath()` |
| 列表页很卡 / 流量爆掉 | 直接挂了原图 | 改 `storage.thumbnail()`，整站统一两三种尺寸 |
| 换了图但页面还是旧图 | 覆盖了同名原图，缩略图是缓存的 | 上传用新 key；或 `thumbnail(key, { refresh: true })` |
| `IMAGE_DECODE_FAILED` | 对非图片（PDF/视频）调了 thumbnail | 只对图片用；其它类型给个图标占位 |
| `IMAGE_TOO_LARGE` | 原图超过 20MB | 让用户上传前压缩，或前端 canvas 压一遍再传 |
