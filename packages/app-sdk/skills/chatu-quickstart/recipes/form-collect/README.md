# form-collect：表单收集

适用：报名、预约、问卷、反馈收集。表单页（zod 校验）+ 成功页 + 后台查看列表。

## 用法

```bash
cp -r .claude/skills/chatu-quickstart/recipes/form-collect src/app/signup   # 目录名换成业务词
```

文件：

- `data.ts` —— 内存数据层（接 chatu-db 时只改这个文件）。
- `page.tsx` —— 表单页，Server Action + zod 校验，失败回显错误。
- `success/page.tsx` —— 提交成功页。
- `admin/page.tsx` —— 提交记录列表（表格）。**默认无鉴权**，正式使用前读 `chatu-auth` 加登录保护。

## 改造点（搜 `TODO(改)`）

1. `data.ts`：`Submission` 字段换成业务表单字段，`SubmissionSchema` 同步改。
2. `page.tsx`：标题、字段控件、文案。
3. 路由：redirect 路径与复制的目录名保持一致。
