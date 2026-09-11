export class AppSdkError extends Error {
  /** 附加信息（如 OAUTH_NOT_CONFIGURED 的 missing 变量名列表），不含任何凭据 */
  details?: Record<string, unknown>
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
    this.name = 'AppSdkError'
  }
}
