import Link from "next/link";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle } from "lucide-react";
import { createItem, deleteItem, listItems, toggleItem } from "./data";

const CreateSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(100),
  note: z.string().trim().max(500).default(""),
});

async function createAction(formData: FormData) {
  "use server";
  const parsed = CreateSchema.safeParse({
    title: formData.get("title"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return; // 首轮从简：校验失败静默忽略；要提示时用 useActionState 返回错误
  await createItem(parsed.data);
  revalidatePath("/");
}

async function toggleAction(formData: FormData) {
  "use server";
  const id = z.string().safeParse(formData.get("id"));
  if (!id.success) return;
  await toggleItem(id.data);
  revalidatePath("/");
}

async function deleteAction(formData: FormData) {
  "use server";
  const id = z.string().safeParse(formData.get("id"));
  if (!id.success) return;
  await deleteItem(id.data);
  revalidatePath("/");
}

export default async function ItemsPage() {
  const items = await listItems();
  const doneCount = items.filter((i) => i.done).length;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        {/* TODO(改) 页面标题与副标题 */}
        <h1 className="text-2xl font-bold tracking-tight">我的清单</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {items.length} 项，已完成 {doneCount} 项
        </p>
      </header>

      <form action={createAction} className="mb-6 flex gap-2">
        {/* TODO(改) 表单字段 */}
        <Input name="title" placeholder="添加一项…" required maxLength={100} className="flex-1" />
        <Input name="note" placeholder="备注（可选）" maxLength={500} className="hidden flex-1 sm:block" />
        <Button type="submit">添加</Button>
      </form>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            还没有内容，从上面添加第一项吧
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <CardContent className="flex items-center gap-3 py-3">
                  <form action={toggleAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="ghost" size="icon" aria-label="切换完成状态">
                      {item.done ? (
                        <CheckCircle2 className="size-5 text-primary" />
                      ) : (
                        <Circle className="size-5 text-muted-foreground" />
                      )}
                    </Button>
                  </form>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/items/${item.id}`} /* TODO(改) 路由前缀与复制的目录名保持一致 */
                      className={`block truncate font-medium hover:underline ${item.done ? "text-muted-foreground line-through" : ""}`}
                    >
                      {item.title}
                    </Link>
                    {item.note && <p className="truncate text-sm text-muted-foreground">{item.note}</p>}
                  </div>
                  {item.done && <Badge variant="secondary">已完成</Badge>}
                  <form action={deleteAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                      删除
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
