import { z } from "zod";

// TODO(改) 表单字段：schema 是唯一事实源，Submission 类型由它推导
export const SubmissionSchema = z.object({
  name: z.string().trim().min(1, "请填写姓名").max(50),
  phone: z
    .string()
    .trim()
    .regex(/^1\d{10}$/, "请填写 11 位手机号"),
  count: z.coerce.number().int().min(1, "至少 1 人").max(20, "最多 20 人"),
  remark: z.string().trim().max(500).default(""),
});

export type SubmissionInput = z.infer<typeof SubmissionSchema>;
export interface Submission extends SubmissionInput {
  id: string;
  createdAt: number;
}

// 内存存储：dev server 进程内持久。接真实存储读 chatu-db，只改下面两个函数。
const store: { rows: Submission[] } = (globalThis as Record<string, unknown>).__formStore as { rows: Submission[] } ??
  ((globalThis as Record<string, unknown>).__formStore = { rows: [] }) as { rows: Submission[] };

export async function addSubmission(input: SubmissionInput): Promise<Submission> {
  const row: Submission = { id: crypto.randomUUID(), createdAt: Date.now(), ...input };
  store.rows.push(row);
  return row;
}

export async function listSubmissions(): Promise<Submission[]> {
  return [...store.rows].sort((a, b) => b.createdAt - a.createdAt);
}
