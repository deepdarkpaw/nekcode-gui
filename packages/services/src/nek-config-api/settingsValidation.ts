/** Wire errors and diagnostics for the shared nek v0.5.1 settings rules. */
import {
  isNekWebSearchProviderSupported,
  NEK_WEB_SEARCH_PROVIDER_MIN_VERSION,
  nekSettingsIssues,
  type NekConfigDiagnostic,
  type NekConfigScope,
  type NekConfigTarget,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { diagnostic } from "./documents.js";
import { fieldErrorsOf, validationError } from "./errors.js";
import type { NekConfigRuntime } from "./runtime.js";

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
export function validateSettingsPatch(
  patch: Record<string, unknown>,
  scope?: NekConfigScope,
): void {
  const issues = nekSettingsIssues(mergeSettingsPatch({}, patch), scope).map(
    ({ path, message }) => ({
      path: path.join("."),
      message,
    }),
  );
  const first = issues[0];
  if (!first) return;
  throw validationError(`${first.path}: ${first.message}`, fieldErrorsOf(issues));
}

export function settingsRuleDiagnostics(
  file: string,
  raw: Record<string, unknown>,
  scope: NekConfigScope,
): NekConfigDiagnostic[] {
  return nekSettingsIssues(raw, scope).map(({ path, message }) =>
    diagnostic(file, `${path.join(".")}: ${message}`),
  );
}

/** Cross-field requirement of `getWebSearchSettings`: a project may inherit an explicit provider. */
const providerRequired =
  "webSearch.apiKey or webSearch.endpoint requires an explicit webSearch.provider";

function webSearchState(record: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(record.webSearch) ? record.webSearch : {};
}

function needsWebSearchProvider(state: Record<string, unknown>): boolean {
  return (
    state.provider === undefined && (state.apiKey !== undefined || state.endpoint !== undefined)
  );
}

export function webSearchMergeDiagnostics(
  file: string,
  effective: Record<string, unknown>,
): NekConfigDiagnostic[] {
  return needsWebSearchProvider(webSearchState(effective))
    ? [diagnostic(file, `webSearch.provider: ${providerRequired}`)]
    : [];
}

export interface WebSearchCapabilities {
  tavily: boolean;
  nekVersion: string | undefined;
}

export async function resolveWebSearchCapabilities(
  runtime: NekConfigRuntime,
  target: NekConfigTarget,
): Promise<WebSearchCapabilities> {
  const nekVersion = await runtime.targetNekVersion(target);
  return { tavily: isNekWebSearchProviderSupported(nekVersion), nekVersion };
}

function tavilyVersionError(capabilities: WebSearchCapabilities): Error {
  const message = `Tavily web search requires nek ${NEK_WEB_SEARCH_PROVIDER_MIN_VERSION} or newer on the target${
    capabilities.nekVersion ? ` (found ${capabilities.nekVersion})` : " (version unknown)"
  }`;
  return validationError(message, { "webSearch.provider": "expected tavily or exa" });
}

/** An older nek would send Tavily credentials to Exa, including on a direct probe. */
export function assertWebSearchProbeSupported(
  settings: Record<string, unknown>,
  capabilities: WebSearchCapabilities,
): void {
  if (!capabilities.tavily && webSearchState(settings).provider === "tavily") {
    throw tavilyVersionError(capabilities);
  }
}

function credentialsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return ["apiKey", "endpoint"].some((key) => {
    const value = after[key];
    return value !== before[key] && typeof value === "string" && value.trim() !== "";
  });
}

/** Allow repairs and unrelated edits, but never introduce ambiguity or write unsupported credentials. */
export function validateWebSearchMerge(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  capabilities: WebSearchCapabilities,
): void {
  const before = webSearchState(previous);
  const after = webSearchState(next);
  const credentialsEdited = credentialsChanged(before, after);
  if (needsWebSearchProvider(after) && (!needsWebSearchProvider(before) || credentialsEdited)) {
    throw validationError("invalid web search settings", {
      "webSearch.provider": providerRequired,
    });
  }
  if (
    !capabilities.tavily &&
    after.provider === "tavily" &&
    (before.provider !== "tavily" || credentialsEdited)
  ) {
    throw tavilyVersionError(capabilities);
  }
}
