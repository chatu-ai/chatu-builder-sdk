// 提交记录查看页。默认无鉴权——正式使用前读 chatu-auth SKILL 加登录保护（requireUser）。
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listSubmissions } from "../data";

export default async function AdminPage() {
  const rows = await listSubmissions();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Card>
        <CardHeader>
          {/* TODO(改) 标题 */}
          <CardTitle>报名记录（{rows.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有提交记录</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {/* TODO(改) 列与 data.ts 字段对应 */}
                  <TableHead>姓名</TableHead>
                  <TableHead>手机号</TableHead>
                  <TableHead>人数</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>{r.phone}</TableCell>
                    <TableCell>{r.count}</TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">{r.remark || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
