/** Validate the JSON draft with the same file rules as host; inherited webSearch rules run on the host. */
import { nekSettingsIssues } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "./settingsPatch.js";

export type RawSettingsValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; kind: "syntax"; message: string }
  | { ok: false; kind: "schema"; issues: Array<{ path: string; message: string }> };

export function validateRawSettings(text: string): RawSettingsValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      kind: "syntax",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, kind: "schema", issues: [{ path: "", message: "Expected a JSON object" }] };
  }
  const issues = nekSettingsIssues(parsed).map(({ path, message }) => ({
    path: path.join("."),
    message,
  }));
  return issues.length > 0 ? { ok: false, kind: "schema", issues } : { ok: true, value: parsed };
}
