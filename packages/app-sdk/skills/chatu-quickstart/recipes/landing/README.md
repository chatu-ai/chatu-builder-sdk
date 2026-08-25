# landing：官网 / 产品落地页

适用：官网、产品介绍、活动宣传页。hero / 特性 / CTA / 页脚四段式，纯 CSS 装饰无外链图。

## 用法

```bash
cp .claude/skills/chatu-quickstart/recipes/landing/page.tsx src/app/page.tsx   # 直接作为首页
```

单文件 recipe，只有 `page.tsx`。

## 改造点（搜 `TODO(改)`）

1. 产品名、标语、三个特性卡的图标与文案；
2. CTA 按钮的目标（锚点或路由）；
3. 配色：改 hero 渐变的两个色（`from-* to-*`）即可整体换风格。
