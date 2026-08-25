# list-detail：一类记录的增删改查

适用：待办、记账、清单、订单、文章、库存……列表 + 详情 + 新增/切换状态/删除。

## 用法

```bash
cp -r .claude/skills/chatu-quickstart/recipes/list-detail src/app/items   # 目录名换成业务词
```

文件：

- `data.ts` —— 内存数据层（含示例数据）。**接 chatu-db 时只改这个文件**，页面代码不动。
- `page.tsx` —— 列表页：新增表单 + 记录卡片 + 状态切换/删除。
- `[id]/page.tsx` —— 详情页。

## 改造点（搜 `TODO(改)`）

1. `data.ts`：`Item` 字段与示例数据换成业务的（标题/金额/状态…）。
2. `page.tsx`：页面标题、表单字段、卡片展示字段。
3. 首页跳转：若这就是应用主功能，把 `src/app/page.tsx` 改成 `redirect('/items')` 或直接把本 recipe 内容放进 `src/app/`。

## 接真实存储（下一轮再做）

读 `chatu-db` SKILL 后，把 `data.ts` 里三个函数的内存实现换成 `db.collection(...)` 调用，函数签名不变。
