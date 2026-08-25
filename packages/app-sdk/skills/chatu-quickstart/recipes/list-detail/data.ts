// 内存数据层：dev server 进程内持久，重启即重置——足够首轮预览用。
// 接真实存储（chatu-db SKILL）时只改本文件：三个导出函数换成 db.collection 实现，签名不变。

// TODO(改) 字段换成业务的
export interface Item {
  id: string;
  title: string;
  note: string;
  done: boolean;
  createdAt: number;
}

// TODO(改) 示例数据换成贴合业务的内容
const seed: Item[] = [
  { id: "1", title: "整理本周待办", note: "周一晨会前完成", done: true, createdAt: Date.now() - 86400_000 * 2 },
  { id: "2", title: "给产品页补充截图", note: "首页 hero 区两张", done: false, createdAt: Date.now() - 86400_000 },
  { id: "3", title: "回复客户邮件", note: "报价单已附上", done: false, createdAt: Date.now() - 3600_000 },
  { id: "4", title: "预订会议室", note: "周四下午 2 点，8 人", done: false, createdAt: Date.now() - 1800_000 },
  { id: "5", title: "更新项目周报", note: "", done: true, createdAt: Date.now() - 600_000 },
];

const store: { items: Item[] } = (globalThis as Record<string, unknown>).__itemsStore as { items: Item[] } ??
  ((globalThis as Record<string, unknown>).__itemsStore = { items: [...seed] }) as { items: Item[] };

export async function listItems(): Promise<Item[]> {
  return [...store.items].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getItem(id: string): Promise<Item | null> {
  return store.items.find((i) => i.id === id) ?? null;
}

export async function createItem(input: Pick<Item, "title" | "note">): Promise<Item> {
  const item: Item = { id: crypto.randomUUID(), done: false, createdAt: Date.now(), ...input };
  store.items.push(item);
  return item;
}

export async function toggleItem(id: string): Promise<void> {
  const item = store.items.find((i) => i.id === id);
  if (item) item.done = !item.done;
}

export async function deleteItem(id: string): Promise<void> {
  store.items = store.items.filter((i) => i.id !== id);
}
