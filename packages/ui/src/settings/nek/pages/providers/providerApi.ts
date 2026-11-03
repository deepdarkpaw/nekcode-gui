/**
 * 服务商端点（models.json `api`）的显示。
 *
 * nek 按“模型 → 服务商 → 内置默认值”解析每个模型的端点，服务商级 `api` 可以不写：
 * 同一网关下混用 OpenAI 与 Anthropic 端点时，端点写在每个模型上。显示规则：
 * - 服务商写了 `api`：显示它；
 * - 没写：模型都用同一种端点就显示那一种，混用显示“按模型设置”；
 * - 都没写（内置服务商用内置默认值）：不显示。
 */
import type { NekEndpointApi, NekProviderView } from "@zcode/shared/nek-protocol";

type ProviderApiSummary = { kind: "api"; api: string } | { kind: "perModel" } | { kind: "none" };

type Translate = (id: string) => string;

/** 完整键名逐个列出：i18n 测试据此检查每个键在两种语言里都有定义。 */
const LABEL_IDS: Record<"full" | "short", Record<NekEndpointApi, string>> = {
  full: {
    "openai-completions": "settings.nek.provider.api.openai-completions",
    "openai-responses": "settings.nek.provider.api.openai-responses",
    "anthropic-messages": "settings.nek.provider.api.anthropic-messages",
    "google-generative-ai": "settings.nek.provider.api.google-generative-ai",
  },
  short: {
    "openai-completions": "settings.nek.provider.apiShort.openai-completions",
    "openai-responses": "settings.nek.provider.apiShort.openai-responses",
    "anthropic-messages": "settings.nek.provider.apiShort.anthropic-messages",
    "google-generative-ai": "settings.nek.provider.apiShort.google-generative-ai",
  },
};

function isEndpointApi(api: string): api is NekEndpointApi {
  return Object.hasOwn(LABEL_IDS.full, api);
}

export function summarizeProviderApi(
  provider: Pick<NekProviderView, "api" | "models">,
): ProviderApiSummary {
  if (provider.api) return { kind: "api", api: provider.api };
  const modelApis = new Set(provider.models.flatMap((model) => (model.api ? [model.api] : [])));
  const [only] = modelApis;
  if (modelApis.size === 1 && only) return { kind: "api", api: only };
  return modelApis.size > 1 ? { kind: "perModel" } : { kind: "none" };
}

/** 端点标签；`null` = 不显示（调用方连同分隔符一起省略）。 */
export function providerApiLabel(
  provider: Pick<NekProviderView, "api" | "models">,
  variant: "full" | "short",
  t: Translate,
): string | null {
  const summary = summarizeProviderApi(provider);
  if (summary.kind === "none") return null;
  if (summary.kind === "perModel") return t("settings.nek.provider.api.perModel");
  return isEndpointApi(summary.api) ? t(LABEL_IDS[variant][summary.api]) : summary.api;
}
