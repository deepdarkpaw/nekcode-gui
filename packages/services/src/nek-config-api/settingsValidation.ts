/** Wire errors and diagnostics for the shared nek v0.5.1 settings rules. */
import { nekSettingsIssues, type NekConfigDiagnostic } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { nekSettingsFileSchema, parseWithSchema } from "../nek-agent/config/schemas.js";
import { diagnostic } from "./documents.js";
import { fieldErrorsOf, validationError } from "./errors.js";

/** `null` is a deletion only at an object key, including a key in a newly created object. */
export function mergeSettingsPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      merged.delete(key);
      continue;
    }
    const previous = merged.get(key);
    merged.set(
      key,
      isPlainObject(value)
        ? mergeSettingsPatch(isPlainObject(previous) ? previous : {}, value)
        : value,
    );
  }
  return Object.fromEntries(merged);
}

/** Check new values without blocking a one-field repair or a different, valid edit. */
export function validateSettingsPatch(patch: Record<string, unknown>): void {
  const validated = parseWithSchema(nekSettingsFileSchema, mergeSettingsPatch({}, patch));
  if (validated.ok) return;
  const first = validated.issues[0];
  throw validationError(
    first ? `${first.path}: ${first.message}` : "invalid settings patch",
    fieldErrorsOf(validated.issues),
  );
}

export function settingsRuleDiagnostics(
  file: string,
  raw: Record<string, unknown>,
): NekConfigDiagnostic[] {
  return nekSettingsIssues(raw).map(({ path, message }) =>
    diagnostic(file, `${path.join(".")}: ${message}`),
  );
}
