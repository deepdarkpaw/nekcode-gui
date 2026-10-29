import type { NekAuthProviderStatus, NekProviderView } from "@zcode/shared/nek-protocol";

/** 只有 OAuth 登录成功才算订阅登录完成；API key 由服务商配置判断。 */
export function isUsableNekAuthStatus(status: NekAuthProviderStatus): boolean {
  return status.kind === "oauth" && status.state === "ok";
}

/** models.json 中存在有效请求地址的服务商即可让用户继续配置。 */
export function isUsableNekProvider(provider: NekProviderView): boolean {
  return provider.baseUrl.trim() !== "";
}

export function isOnboardingAccountComplete(input: {
  authStatuses: readonly NekAuthProviderStatus[];
  providers: readonly NekProviderView[];
}): boolean {
  return (
    input.authStatuses.some(isUsableNekAuthStatus) || input.providers.some(isUsableNekProvider)
  );
}
