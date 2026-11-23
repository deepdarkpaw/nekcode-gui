/**
 * File-value checks for nek v0.5.1: core/settings-manager.ts, core/compaction/content-policy.ts,
 * core/http-dispatcher.ts, core/package-manager.ts and modes/rpc/gui/models.ts.
 * `validate_config` does not run these getters or accept a candidate file. Do not infer
 * rejection rules from TypeScript enums or from the GUI's choice list.
 */
import { NEK_WEB_SEARCH_PROVIDERS, type NekConfigScope } from "./config-types.js";
import { NEK_THINKING_LEVELS } from "./gui-rpc.js";

export const NEK_COMPACTION_CONTENT_MINIMUMS = {
  thinkingMaxChars: 0,
  thinkingTotalMaxChars: 0,
  toolResultMaxChars: 256,
  toolErrorMaxChars: 256,
  toolArgumentMaxChars: 256,
  protectedRecentTokens: 0,
  protectedToolResults: 0,
} as const;

interface SettingsIssue {
  path: string[];
  message: string;
}

type AddIssue = (path: string[], message: string) => void;

type CompactionRule =
  | { kind: "object" | "boolean" | "unknownContentKey" | "modelRef" | "thinkingLevel" }
  | { kind: "safeInteger"; minimum: number };

interface CompactionIssue extends SettingsIssue {
  rule: CompactionRule;
}

type AddCompactionIssue = (path: string[], message: string, rule: CompactionRule) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function checkContent(value: unknown, add: AddCompactionIssue): void {
  if (value === undefined) return;
  const path = ["compaction", "content"];
  if (!isRecord(value)) {
    add(path, "expected an object", { kind: "object" });
    return;
  }
  for (const key of Object.keys(value)) {
    // Match nek's membership test against its default object (including inherited names).
    if (key !== "pruneToolResults" && !(key in NEK_COMPACTION_CONTENT_MINIMUMS)) {
      add([...path, key], "unknown compaction content setting", { kind: "unknownContentKey" });
    }
  }
  for (const [key, minimum] of Object.entries(NEK_COMPACTION_CONTENT_MINIMUMS)) {
    if (value[key] !== undefined && !safeInteger(value[key], minimum)) {
      add([...path, key], `expected a safe integer >= ${minimum}`, {
        kind: "safeInteger",
        minimum,
      });
    }
  }
  if (value.pruneToolResults !== undefined && typeof value.pruneToolResults !== "boolean") {
    add([...path, "pruneToolResults"], "expected a boolean", { kind: "boolean" });
  }
}

function checkTokens(
  record: Record<string, unknown>,
  path: string[],
  add: AddCompactionIssue,
): void {
  for (const key of ["reserveTokens", "keepRecentTokens"]) {
    if (record[key] !== undefined && !safeInteger(record[key], 0)) {
      add([...path, key], "expected a non-negative safe integer", {
        kind: "safeInteger",
        minimum: 0,
      });
    }
  }
}

function checkCompaction(value: unknown, add: AddCompactionIssue): void {
  // The getters access members via optional chaining, with no enclosing shape check.
  if (!isRecord(value)) return;
  checkContent(value.content, add);
  checkTokens(value, ["compaction"], add);
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !/^[^/\s]+\/\S+$/.test(value.model))
  ) {
    add(["compaction", "model"], "expected exact provider/modelId", { kind: "modelRef" });
  }
  if (
    value.thinkingLevel !== undefined &&
    !NEK_THINKING_LEVELS.some((level) => level === value.thinkingLevel)
  ) {
    add(["compaction", "thinkingLevel"], `expected one of ${NEK_THINKING_LEVELS.join(", ")}`, {
      kind: "thinkingLevel",
    });
  }

  if (!isRecord(value.modelOverrides)) return;
  for (const [key, entry] of Object.entries(value.modelOverrides)) {
    // Only keys that can be looked up as `${model.provider}/${model.id}` are used by nek.
    if (!key.slice(1, -1).includes("/") || entry === undefined) continue;
    const path = ["compaction", "modelOverrides", key];
    if (!isRecord(entry)) add(path, "expected an object", { kind: "object" });
    else checkTokens(entry, path, add);
  }
}

/** Same compaction checks as the host, with structured details for localized field feedback. */
export function nekCompactionIssues(value: unknown): CompactionIssue[] {
  const issues: CompactionIssue[] = [];
  checkCompaction(value, (path, message, rule) => issues.push({ path, message, rule }));
  return issues;
}

/** `core/http-dispatcher.ts` accepts finite non-negative numbers, numeric strings and `disabled`. */
export function parseNekTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    if (text.toLowerCase() === "disabled") return 0;
    value = Number(text);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function checkWebSearch(value: unknown, add: AddIssue): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add(["webSearch"], "expected an object");
    return;
  }
  if (
    value.provider !== undefined &&
    !NEK_WEB_SEARCH_PROVIDERS.some((name) => name === value.provider)
  ) {
    add(["webSearch", "provider"], "expected tavily or exa");
  }
  for (const key of ["endpoint", "apiKey"]) {
    const text = value[key];
    if (text !== undefined && (typeof text !== "string" || !text.trim())) {
      add(["webSearch", key], "expected a nonempty string");
    }
  }
  const count = value.numResults;
  if (count !== undefined && (!safeInteger(count, 1) || Number(count) > 20)) {
    add(["webSearch", "numResults"], "expected an integer from 1 to 20");
  }
}

/** Non-string entries fail when nek tries to use each string; no name or pattern restrictions here. */
function checkStringArray(value: unknown, path: string[], add: AddIssue): void {
  if (!Array.isArray(value)) {
    add(path, "expected an array of strings");
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") add([...path, String(index)], "expected a string");
  }
}

function checkResources(settings: Record<string, unknown>, add: AddIssue): void {
  for (const key of ["extensions", "skills", "prompts", "themes"]) {
    const value = settings[key];
    if (key === "skills" && isRecord(value)) {
      // The legacy object is migrated to the customDirectories array or no explicit paths.
      if (Array.isArray(value.customDirectories))
        checkStringArray(value.customDirectories, [key, "customDirectories"], add);
    } else if (value != null && typeof value !== "string") {
      checkStringArray(value, [key], add);
    }
  }
  const packages = settings.packages;
  if (packages == null || typeof packages === "string") return; // Both iterable in core.
  if (!Array.isArray(packages)) {
    add(["packages"], "expected iterable package sources");
    return;
  }
  for (const [index, pkg] of packages.entries()) {
    if (typeof pkg !== "string" && (!isRecord(pkg) || typeof pkg.source !== "string")) {
      add(
        ["packages", String(index)],
        "expected a source string or an object with a string source",
      );
    }
  }
}

/** Validates file values, not patch deletion markers or runtime facts such as model and credential availability. */
export function nekSettingsIssues(
  settings: Record<string, unknown>,
  scope: NekConfigScope = "global",
): SettingsIssue[] {
  const issues: SettingsIssue[] = nekCompactionIssues(settings.compaction);
  const add: AddIssue = (path, message) => issues.push({ path, message });
  checkWebSearch(settings.webSearch, add);
  for (const key of ["httpIdleTimeoutMs", "websocketConnectTimeoutMs"]) {
    const value = settings[key];
    if (value !== undefined && parseNekTimeoutMs(value) === undefined) {
      add([key], 'expected a finite non-negative number, a numeric string, or "disabled"');
    }
  }
  if (scope === "global" && settings.httpProxy != null && typeof settings.httpProxy !== "string") {
    add(["httpProxy"], "expected a string");
  }
  for (const key of ["shellPath", "sessionDir"]) {
    if (settings[key] && typeof settings[key] !== "string") add([key], "expected a path string");
  }
  if (settings.defaultTools) checkStringArray(settings.defaultTools, ["defaultTools"], add);
  if (settings.enabledModels != null)
    checkStringArray(settings.enabledModels, ["enabledModels"], add);
  checkResources(settings, add);
  return issues;
}
