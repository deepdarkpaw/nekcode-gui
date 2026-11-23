/** Static settings rules not exposed by RPC: nek v0.5.1 core/settings-manager.ts and core/compaction/content-policy.ts. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function checkContent(value: unknown, add: AddIssue): void {
  if (value === undefined) return;
  const path = ["compaction", "content"];
  if (!isRecord(value)) {
    add(path, "expected an object");
    return;
  }
  for (const key of Object.keys(value)) {
    // Match nek's membership test against its default object (including inherited names).
    if (key !== "pruneToolResults" && !(key in NEK_COMPACTION_CONTENT_MINIMUMS)) {
      add([...path, key], "unknown compaction content setting");
    }
  }
  for (const [key, minimum] of Object.entries(NEK_COMPACTION_CONTENT_MINIMUMS)) {
    if (value[key] !== undefined && !safeInteger(value[key], minimum)) {
      add([...path, key], `expected a safe integer >= ${minimum}`);
    }
  }
  if (value.pruneToolResults !== undefined && typeof value.pruneToolResults !== "boolean") {
    add([...path, "pruneToolResults"], "expected a boolean");
  }
}

function checkTokens(record: Record<string, unknown>, path: string[], add: AddIssue): void {
  for (const key of ["reserveTokens", "keepRecentTokens"]) {
    if (record[key] !== undefined && !safeInteger(record[key], 0)) {
      add([...path, key], "expected a non-negative safe integer");
    }
  }
}

function checkCompaction(value: unknown, add: AddIssue): void {
  // The getters access members via optional chaining, with no enclosing shape check.
  if (!isRecord(value)) return;
  checkContent(value.content, add);
  checkTokens(value, ["compaction"], add);
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !/^[^/\s]+\/\S+$/.test(value.model))
  ) {
    add(["compaction", "model"], "expected exact provider/modelId");
  }
  if (
    value.thinkingLevel !== undefined &&
    !NEK_THINKING_LEVELS.some((level) => level === value.thinkingLevel)
  ) {
    add(["compaction", "thinkingLevel"], `expected one of ${NEK_THINKING_LEVELS.join(", ")}`);
  }

  if (!isRecord(value.modelOverrides)) return;
  for (const [key, entry] of Object.entries(value.modelOverrides)) {
    // Only keys that can be looked up as `${model.provider}/${model.id}` are used by nek.
    if (!key.slice(1, -1).includes("/") || entry === undefined) continue;
    const path = ["compaction", "modelOverrides", key];
    if (!isRecord(entry)) add(path, "expected an object");
    else checkTokens(entry, path, add);
  }
}

/** Validates file values, not patch deletion markers or runtime facts such as model and credential availability. */
export function nekSettingsIssues(settings: Record<string, unknown>): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  checkCompaction(settings.compaction, (path, message) => issues.push({ path, message }));
  return issues;
}
