import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addSubmission, SubmissionSchema } from "./data";

async function submitAction(formData: FormData) {
  "use server";
  const parsed = SubmissionSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    count: formData.get("count"),
    remark: formData.get("remark") ?? "",
  });
  // 首轮从简：校验失败回表单页（浏览器端 required/pattern 已挡住大多数情况）。
  // 需要逐字段错误提示时改用 useActionState 返回 parsed.error.flatten()。
  if (!parsed.success) redirect("/signup?error=1"); // TODO(改) 路径与目录名一致
  await addSubmission(parsed.data);
  redirect("/signup/success"); // TODO(改) 路径与目录名一致
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          {/* TODO(改) 标题与说明 */}
          <CardTitle className="text-xl">活动报名</CardTitle>
          <CardDescription>填写以下信息完成报名，我们会尽快与你联系。</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              提交内容有误，请检查后重新提交。
            </p>
          )}
          <form action={submitAction} className="space-y-4">
            {/* TODO(改) 表单字段，与 data.ts 的 schema 对应 */}
            <div className="space-y-2">
              <Label htmlFor="name">姓名</Label>
              <Input id="name" name="name" required maxLength={50} placeholder="你的姓名" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">手机号</Label>
              <Input id="phone" name="phone" required pattern="1\d{10}" placeholder="11 位手机号" inputMode="numeric" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="count">人数</Label>
              <Input id="count" name="count" type="number" required min={1} max={20} defaultValue={1} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="remark">备注（可选）</Label>
              <Textarea id="remark" name="remark" maxLength={500} placeholder="其他需要说明的信息" />
            </div>
            <Button type="submit" className="w-full">
              提交报名
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
