import type {
  NekAuthProviderStatus,
  NekProviderView,
} from "@zcode/shared/nek-protocol";

const USABLE_AUTH_KINDS = new Set<NekAuthProviderStatus["kind"]>(["oauth", "api_key", "env"]);

/** OAuth 过期或刷新失败不能让第二步误判为已完成。 */
export function isUsableNekAuthStatus(status: NekAuthProviderStatus): boolean {
  return status.state === "ok" && USABLE_AUTH_KINDS.has(status.kind);
}

/** 服务商必须有请求地址、凭据和至少一个模型，才算可以直接继续。 */
export function isUsableNekProvider(provider: NekProviderView): boolean {
  return (
    provider.baseUrl.trim() !== "" &&
    provider.models.length > 0 &&
    provider.apiKey.kind !== "none"
  );
}

export function isOnboardingAccountComplete(input: {
  authStatuses: readonly NekAuthProviderStatus[];
  providers: readonly NekProviderView[];
}): boolean {
  return (
    input.authStatuses.some(isUsableNekAuthStatus) || input.providers.some(isUsableNekProvider)
  );
}
