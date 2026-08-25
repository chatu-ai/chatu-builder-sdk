import Link from "next/link";
import { Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// TODO(改) 产品信息集中在这里，页面结构一般不用动
const site = {
  name: "云雀笔记",
  tagline: "把灵感变成行动",
  description: "随手记录、自动整理、多端同步的轻量笔记工具，让每一个想法都不被遗忘。",
  cta: { label: "免费开始使用", href: "#features" },
  features: [
    { icon: Sparkles, title: "随手记录", desc: "打开即写，支持文字、清单与标签，三秒内记下一个想法。" },
    { icon: Rocket, title: "自动整理", desc: "按时间与标签自动归档，回顾时一目了然，不用手动收拾。" },
    { icon: ShieldCheck, title: "数据安全", desc: "内容云端加密保存，多端同步，换设备也不丢失。" },
  ],
};

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      {/* Hero —— TODO(改) 渐变两端颜色即可整体换风格 */}
      <section className="bg-gradient-to-br from-indigo-600 to-violet-500 px-4 py-24 text-white">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="secondary" className="mb-4">
            {site.tagline}
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{site.name}</h1>
          <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-white/85">{site.description}</p>
          <Button render={<Link href={site.cta.href} />} size="lg" variant="secondary" className="mt-8">
            {site.cta.label}
          </Button>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-4 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-2xl font-bold tracking-tight">为什么选择{site.name}</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {site.features.map((f) => (
              <Card key={f.title}>
                <CardContent className="pt-6">
                  <f.icon className="size-8 text-primary" />
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{f.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-20">
        <div className="mx-auto max-w-3xl rounded-2xl bg-muted px-6 py-14 text-center">
          <h2 className="text-2xl font-bold tracking-tight">现在就开始</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            无需下载，打开浏览器即可使用。
          </p>
          <Button render={<Link href={site.cta.href} />} size="lg" className="mt-6">
            {site.cta.label}
          </Button>
        </div>
      </section>

      <footer className="border-t px-4 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} {site.name}
      </footer>
    </main>
  );
}
