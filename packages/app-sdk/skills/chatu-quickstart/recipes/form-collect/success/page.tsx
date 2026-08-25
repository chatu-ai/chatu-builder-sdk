import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function SuccessPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <CheckCircle2 className="size-12 text-primary" />
          {/* TODO(改) 成功文案 */}
          <h1 className="text-xl font-semibold">报名成功</h1>
          <p className="text-sm text-muted-foreground">我们已收到你的信息，会尽快与你联系。</p>
          {/* TODO(改) 路径与目录名一致 */}
          <Button render={<Link href="/signup" />} variant="outline" className="mt-2">
            再报一名
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
