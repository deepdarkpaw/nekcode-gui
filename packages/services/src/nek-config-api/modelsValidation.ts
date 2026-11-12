/** Deterministic endpoint resolution: never borrow a sibling model's transport. */
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { validationError } from "./errors.js";

interface ModelEndpointIssue {
  modelId: string;
  field: "api" | "baseUrl";
  index: number;
}

export function modelEndpointIssues(
  provider: Record<string, unknown>,
  builtin: boolean,
): ModelEndpointIssue[] {
  if (builtin) return [];
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.flatMap((model, index) => {
    if (!isPlainObject(model)) return [];
    const modelId = typeof model.id === "string" ? model.id : `#${index + 1}`;
    return (["api", "baseUrl"] as const).flatMap((field) => {
      const value = model[field] ?? provider[field];
      return typeof value === "string" && value.trim() ? [] : [{ modelId, field, index }];
    });
  });
}

/** Permit incremental repair, but never introduce new or preserve all existing ambiguity. */
export function validateModelEndpoints(
  providerId: string,
  provider: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  builtin: boolean,
): void {
  const issues = modelEndpointIssues(provider, builtin);
  if (issues.length === 0) return;
  const before = modelEndpointIssues(previous ?? {}, builtin);
  const key = (issue: ModelEndpointIssue) => JSON.stringify([issue.modelId, issue.field]);
  const oldKeys = new Set(before.map(key));
  if (issues.length < before.length && issues.every((issue) => oldKeys.has(key(issue)))) return;
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    fieldErrors[`providers.${providerId}.models.${issue.index}.${issue.field}`] =
      `model "${issue.modelId}" requires "${issue.field}" on the model or provider; sibling defaults are not safe`;
  }
  throw validationError(
    `provider "${providerId}": ${Object.values(fieldErrors).join("; ")}`,
    fieldErrors,
  );
}
