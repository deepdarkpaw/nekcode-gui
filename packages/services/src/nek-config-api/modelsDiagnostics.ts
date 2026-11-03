/**
 * models.json 的结构性诊断：nek 加载时也会报，GUI 在设置页提前显示。
 *
 * 规则与 nek 的 provider-composer 一致：每个模型的 `api` / `baseUrl` 依次取模型、服务商、
 * 内置默认值。
 * - nek 内置服务商（`BUILTIN_PROVIDER_IDS`）总能落到内置模型的默认值，不报；
 * - 自定义服务商没有内置默认值：只要有一个模型在模型和服务商上都拿不到 `api` 或 `baseUrl`，
 *   nek 就无法加载这个服务商的模型列表，报错误；
 * - 服务商级 `api` 缺失、但每个模型都写了 `api`（同一网关混用 OpenAI 与 Anthropic 端点）是合法写法，不报。
 */
import type { NekConfigDiagnostic } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { BUILTIN_PROVIDER_IDS, type NekModelsSnapshot } from "./modelsDocument.js";

/** 诊断里最多点名的模型数，其余折叠成计数。 */
const NAMED_MODELS_LIMIT = 5;

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function modelIdOf(model: Record<string, unknown>, index: number): string {
  return hasText(model.id) ? String(model.id) : `#${index + 1}`;
}

function nameModels(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_MODELS_LIMIT).map((id) => `"${id}"`);
  const rest = ids.length - named.length;
  return rest > 0 ? `${named.join(", ")} (+${rest} more)` : named.join(", ");
}

/** 自定义服务商里拿不到某个字段的模型 id（模型和服务商上都没有）。 */
function modelsMissing(
  provider: Record<string, unknown>,
  models: readonly Record<string, unknown>[],
  field: "api" | "baseUrl",
): string[] {
  if (hasText(provider[field])) return [];
  return models.flatMap((model, index) => (hasText(model[field]) ? [] : [modelIdOf(model, index)]));
}

export function modelsDiagnostics(snapshot: NekModelsSnapshot): NekConfigDiagnostic[] {
  const diagnostics: NekConfigDiagnostic[] = [];
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (BUILTIN_PROVIDER_IDS.has(id)) continue;
    const models = Array.isArray(provider.models) ? provider.models.filter(isPlainObject) : [];
    for (const field of ["api", "baseUrl"] as const) {
      const missing = modelsMissing(provider, models, field);
      if (missing.length === 0) continue;
      diagnostics.push({
        file: snapshot.path,
        severity: "error",
        message: `provider "${id}": no "${field}" for model ${nameModels(missing)}; set "${field}" on the provider or on each model, otherwise nek cannot load this provider's models`,
      });
    }
  }
  return diagnostics;
}
