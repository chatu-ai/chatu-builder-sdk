# 看板页（KPI + 趋势 + 分布 + Top N）

`/admin/dashboard`，数据全部来自 `db.aggregate`（服务端分组，只回几行），图表用已预装的 recharts。
放在 `/admin` 下面就自动受 `chatu-admin` 的 layout 守卫保护；没有后台的应用把路径换掉即可。

## 1. 页面（Server Component）

```tsx
// src/app/admin/dashboard/page.tsx
import { db } from '@/lib/platform';
import { TrendChart, StatusPie } from './charts';

export const dynamic = 'force-dynamic';   // 看板必须实时

interface Order { amount: number; status: string; userId: string; channel?: string }

export default async function DashboardPage() {
  const orders = db.collection<Order>('orders');
  const since = Date.now() - 29 * 86400_000;

  // 四个统计并发发出去，别串行 await
  const [[kpi], byDay, byStatus, top] = await Promise.all([
    orders.aggregate({
      filter: { status: 'paid' },
      metrics: { n: { $count: true }, total: { $sum: 'amount' }, avg: { $avg: 'amount' }, users: { $countDistinct: 'userId' } },
    }),
    orders.aggregate({
      filter: { status: 'paid', _createdAt: { $gte: since } },
      groupBy: { field: '_createdAt', unit: 'day' },       // 默认北京时间
      metrics: { n: { $count: true }, total: { $sum: 'amount' } },
    }),
    orders.aggregate({ groupBy: 'status', metrics: { n: { $count: true } }, sort: { n: -1 } }),
    orders.aggregate({ groupBy: 'userId', metrics: { total: { $sum: 'amount' }, n: { $count: true } }, sort: { total: -1 }, limit: 10 }),
  ]);

  const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">数据看板</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="成交订单" value={String(kpi?.n ?? 0)} />
        <Kpi label="成交金额" value={yuan(kpi?.total ?? 0)} />
        <Kpi label="客单价" value={yuan(kpi?.avg ?? 0)} />
        <Kpi label="下单人数" value={String(kpi?.users ?? 0)} />
      </div>

      <section className="rounded-xl border p-4">
        <h2 className="mb-3 text-sm text-muted-foreground">最近 30 天</h2>
        {/* 补齐没有订单的那几天，折线才不会断 */}
        <TrendChart data={fillDays(byDay, since)} />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border p-4">
          <h2 className="mb-3 text-sm text-muted-foreground">状态分布</h2>
          <StatusPie data={byStatus.map(r => ({ name: String(r.key ?? '未填'), value: r.n }))} />
        </section>

        <section className="rounded-xl border p-4">
          <h2 className="mb-3 text-sm text-muted-foreground">消费 Top 10</h2>
          <table className="w-full text-sm">
            <tbody>
              {top.map((r, i) => (
                <tr key={String(r.key)} className="border-b last:border-0">
                  <td className="py-2 text-muted-foreground">{i + 1}</td>
                  <td className="py-2">{String(r.key ?? '匿名')}</td>
                  <td className="py-2 text-right tabular-nums">{yuan(r.total)}</td>
                  <td className="py-2 text-right text-muted-foreground">{r.n} 单</td>
                </tr>
              ))}
              {top.length === 0 && <tr><td className="py-6 text-center text-muted-foreground" colSpan={4}>还没有数据</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** aggregate 只返回有数据的那些天，补齐空白天（按北京时间，与分桶口径一致） */
function fillDays(rows: Array<{ key: string | number | boolean | null; n: number; total: number }>, since: number) {
  const got = new Map(rows.map(r => [String(r.key), r]));
  const out: Array<{ day: string; n: number; total: number }> = [];
  for (let t = since; t <= Date.now(); t += 86400_000) {
    const day = new Date(t + 480 * 60_000).toISOString().slice(0, 10);
    const hit = got.get(day);
    out.push({ day: day.slice(5), n: hit?.n ?? 0, total: hit?.total ?? 0 });
  }
  return out;
}
```

## 2. 图表（客户端组件）

```tsx
// src/app/admin/dashboard/charts.tsx
'use client';
import { Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6'];

export function TrendChart({ data }: { data: Array<{ day: string; n: number; total: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data}>
        <XAxis dataKey="day" tick={{ fontSize: 12 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 12 }} width={48} />
        <Tooltip formatter={(v, name) => [name === 'total' ? `¥${v}` : `${v}`, name === 'total' ? '金额' : '订单数']} />
        <Line type="monotone" dataKey="total" stroke={COLORS[0]} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function StatusPie({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} label={d => `${d.name} ${d.value}`}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}
```

## 要点

- **四个统计并发发**（`Promise.all`），串行 await 会让页面明显变慢。
- 趋势图要**补齐空白天**：`aggregate` 只返回有数据的桶，不补的话折线会跳着连。
- 时间范围用 `filter` 限定（`_createdAt: { $gte: … }`），不要把整个集合都算上再在前端切。
- 图表组件必须是 `'use client'`；页面本身保持 Server Component，数据不进浏览器。
- 空数据要有兜底文案（新应用第一天打开就是空的）。
- 需要"导出这张表"时见 `chatu-admin/references/export-import.md`。
