/**
 * Diagnose unresolved custom endpoints before nek composes the provider. Some nek versions
 * borrow defaults from preceding custom models; that is order-dependent, not safe inheritance.
 */
import type { NekConfigDiagnostic } from "@zcode/shared/nek-protocol";
import { BUILTIN_PROVIDER_IDS, type NekModelsSnapshot } from "./modelsDocument.js";
import { modelEndpointIssues } from "./modelsValidation.js";

/** Bound diagnostic detail even for a large imported list. */
const NAMED_MODELS_LIMIT = 5;

function nameModels(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_MODELS_LIMIT).map((id) => `"${id}"`);
  const rest = ids.length - named.length;
  return rest > 0 ? `${named.join(", ")} (+${rest} more)` : named.join(", ");
}

export function modelsDiagnostics(snapshot: NekModelsSnapshot): NekConfigDiagnostic[] {
  const diagnostics: NekConfigDiagnostic[] = [];
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    const issues = modelEndpointIssues(provider, BUILTIN_PROVIDER_IDS.has(id));
    for (const field of ["api", "baseUrl"] as const) {
      const missing = issues.filter((issue) => issue.field === field).map((issue) => issue.modelId);
      if (missing.length === 0) continue;
      diagnostics.push({
        file: snapshot.path,
        severity: "error",
        message: `provider "${id}": no "${field}" for model ${nameModels(missing)}; set "${field}" on the provider or on each model to avoid load failures or order-dependent endpoint selection`,
      });
    }
  }
  return diagnostics;
}
