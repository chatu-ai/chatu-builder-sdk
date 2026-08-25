import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getItem } from "../data";

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {/* TODO(改) 返回路径与复制的目录名保持一致 */}
      <Button render={<Link href="/items" />} variant="ghost" size="sm" className="mb-4">
        ← 返回列表
      </Button>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-xl">{item.title}</CardTitle>
            <Badge variant={item.done ? "secondary" : "default"}>{item.done ? "已完成" : "进行中"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* TODO(改) 详情字段 */}
          <p className="text-sm leading-6 text-muted-foreground">{item.note || "（无备注）"}</p>
          <Separator />
          <p className="text-xs text-muted-foreground">
            创建于 {new Date(item.createdAt).toLocaleString("zh-CN")}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
