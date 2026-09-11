# 导出 CSV / 导入 CSV

`toCsv` / `parseCsv` 来自 `@chatu-ai/app-sdk`（模板里 `@/lib/platform` 已转出），纯函数、零依赖。
**不要**装 `xlsx` / `papaparse` / `json2csv`——CSV 带 BOM 用 Excel 打开就是正常表格。

## 导出：Route Handler 直接下载

```ts
// src/app/admin/applications/export/route.ts
import { auth, currentUser, db, toCsv } from '@/lib/platform';

export const dynamic = 'force-dynamic';

interface Application { name: string; phone: string; status: string; note?: string }

export async function GET() {
  try { auth.requireRole(await currentUser(), 'admin'); }
  catch { return Response.json({ error: 'forbidden' }, { status: 403 }); }

  const rows = await allDocs<Application>('applications');   // 见下面"分页取完"
  const csv = toCsv(rows, {
    columns: [
      { key: 'name', label: '姓名' },
      { key: 'phone', label: '手机号' },
      { key: 'status', label: '状态', value: r => ({ pending: '待处理', approved: '已通过' }[r.status] ?? r.status) },
      { key: '_createdAt', label: '提交时间', value: r => new Date(r._createdAt).toLocaleString('zh-CN') },
    ],
  });

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // 中文文件名要 filename*=UTF-8''，否则部分浏览器会乱码
      'content-disposition': `attachment; filename="applications.csv"; filename*=UTF-8''${encodeURIComponent('报名表.csv')}`,
    },
  });
}
```

页面上就是一个普通链接：`<a href="/admin/applications/export">导出 CSV</a>`（不要用 fetch + Blob 那一套）。

## 分页取完（必须）

`find` 单页上限 200，导出要循环取完，并且**加个上限兜底**别把内存撑爆：

```ts
async function allDocs<T>(name: string, max = 5000) {
  const c = db.collection<T>(name);
  const out: Awaited<ReturnType<typeof c.find>>['docs'] = [];
  let skip: number | null = 0;
  while (skip !== null && out.length < max) {
    const page = await c.find({ sort: { _createdAt: -1 }, skip, limit: 200 });
    out.push(...page.docs);
    skip = page.nextSkip;
  }
  return out;
}
```

数据量超过几千条时提示用户"只导出最近 5000 条"，或按时间范围 `filter` 分批导。

## 导入：先校验，再写库

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth, currentUser, db, parseCsv } from '@/lib/platform';

const Row = z.object({
  姓名: z.string().min(1, '不能为空'),
  手机号: z.string().regex(/^1\d{10}$/, '手机号格式不对'),
});

export async function importApplications(formData: FormData) {
  const user = await currentUser();
  if (!auth.roles.has(user, 'admin')) return { error: '没有权限' };

  const file = formData.get('file');
  if (!(file instanceof File)) return { error: '请选择文件' };
  const { rows } = parseCsv(await file.text());
  if (rows.length === 0) return { error: '文件里没有数据' };
  if (rows.length > 1000) return { error: '一次最多导入 1000 行，请拆分' };

  // 全部先校验，有错就整批不写——别写一半留下脏数据
  const errors: string[] = [];
  const docs = rows.map((row, i) => {
    const parsed = Row.safeParse(row);
    if (!parsed.success) {
      errors.push(`第 ${i + 2} 行：${parsed.error.issues.map(x => `${x.path.join('.')} ${x.message}`).join('；')}`);
      return null;
    }
    return { name: parsed.data.姓名, phone: parsed.data.手机号, status: 'pending' };
  });
  if (errors.length) return { error: `有 ${errors.length} 行有问题`, details: errors.slice(0, 10) };

  await db.collection('applications').insertMany(docs.filter(Boolean) as Record<string, unknown>[]);
  revalidatePath('/admin/applications');
  return { ok: true, inserted: docs.length };
}
```

行号 = 数组下标 + 2（第 1 行是表头），报错时一定带上行号，用户才知道改哪。

## 要点

- 表头用中文时，`Row` 的字段名就写中文（`parseCsv` 按表头原样取值）；也可以先做一层"中文表头 → 字段名"的映射表。
- 导入要**幂等/去重**（同一个文件被点两次）：用 `getOrCreate({ phone }, {...})` 代替 `insertMany`，或先按唯一字段查一遍（见 `chatu-db` 的「并发与唯一性」）。
- 上传的文件不用存 `storage`，读完 `text()` 就丢；确实要留档再 `storage.put`。
- 导出的表格里**不要**带 `_id` 以外的内部字段（会话 token、其他人的隐私字段）；导出什么列要按页面上展示的来。
