/** auth provider 接口：内部=Cookie 会话；开放 API=API Key（P2）。（04 §1 约束 1） */
export interface AuthProvider {
  /** 为请求附加认证信息（headers / credentials 模式） */
  apply(init: RequestInit): RequestInit
}

export class CookieAuth implements AuthProvider {
  apply(init: RequestInit): RequestInit {
    return { ...init, credentials: 'include' }
  }
}

export class ApiKeyAuth implements AuthProvider {
  constructor(private readonly apiKey: string) {}
  apply(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.apiKey}` },
    }
  }
}
