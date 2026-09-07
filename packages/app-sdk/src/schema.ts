import { AppSdkError } from './errors.js'

/**
 * Standard Schema（https://standardschema.dev）：zod ≥3.24 / zod 4 / valibot / arktype 都实现了这个接口。
 * SDK 只依赖这个最小接口，不依赖任何校验库——应用自带 zod 即可（技术方案 18 §B）。
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output }
  }
}
export type StandardResult<T> = { value: T; issues?: undefined } | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object' && value !== null && '~standard' in value && typeof (value as any)['~standard']?.validate === 'function'
}

/** 把 issues 压成一行可读信息（给错误消息与 ai.json 的重试提示用） */
export function formatIssues(issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }>): string {
  return issues.slice(0, 5).map(i => {
    const path = (i.path ?? []).map(p => (typeof p === 'object' && p !== null && 'key' in p ? String(p.key) : String(p))).join('.')
    return path ? `${path}: ${i.message}` : i.message
  }).join('; ')
}

/** 用 Standard Schema 校验；失败抛 AppSdkError(code)，消息含前几条 issue */
export async function validateWith<T>(schema: StandardSchemaV1<unknown, T>, value: unknown, code = 'INVALID_DATA', what = 'data'): Promise<T> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) throw new AppSdkError(code, `${what} 不符合 schema：${formatIssues(result.issues)}`)
  return result.value
}
