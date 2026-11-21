import {
  NEK_THINKING_LEVELS,
  type NekCatalogModel,
  type NekModelScopeResult,
  type NekProviderConfig,
  type NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import { mockError, type MockMachine } from "./mockMachine.js";
import type { Touch } from "./mockModels.js";

const refOf = ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`;

function projectFile(machine: MockMachine, cwd?: string) {
  if (!cwd || !(machine.trust.get(cwd) ?? machine.settings.value.defaultProjectTrust === "always"))
    return undefined;
  return machine.projectSettings.get(cwd);
}

function scopeFile(machine: MockMachine, cwd?: string) {
  const project = projectFile(machine, cwd);
  return project?.value.enabledModels !== undefined ? project : machine.settings;
}

/** mock 只提供显式 ID、裸 ID 和简单通配符的测试事实，生产范围匹配由 nek 完成。 */
export function mockModelScope(
  machine: MockMachine,
  available: NekCatalogModel[],
  cwd?: string,
): NekModelScopeResult {
  const patterns = scopeFile(machine, cwd).value.enabledModels ?? [];
  const result: NekModelScopeResult = { patterns, models: [], diagnostics: [] };
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const colon = pattern.lastIndexOf(":");
    const exact = available.filter((model) => refOf(model) === pattern);
    const suffix = colon > -1 && exact.length === 0 ? pattern.slice(colon + 1) : undefined;
    const base = suffix === undefined ? pattern : pattern.slice(0, colon);
    const thinkingLevel = NEK_THINKING_LEVELS.find((level) => level === suffix);
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const regex = new RegExp(`^${base.split("*").map(literal).join(".*")}$`, "iu");
    const matches = exact.length
      ? exact
      : available.filter((model) => regex.test(refOf(model)) || regex.test(model.id));
    if (!matches.length) {
      result.diagnostics.push({
        code: "no-match",
        pattern,
        message: `No models match pattern "${pattern}"`,
      });
    } else if (matches.length > 1 && !base.includes("*")) {
      result.diagnostics.push({
        code: "ambiguous",
        pattern,
        message: `Pattern "${pattern}" matches several providers`,
      });
    }
    if (matches.length && suffix && !thinkingLevel) {
      result.diagnostics.push({
        code: "invalid-thinking-level",
        pattern,
        message: `Invalid thinking level "${suffix}"`,
      });
    }
    for (const { provider, id } of matches) {
      const key = refOf({ provider, id });
      if (seen.has(key)) continue;
      seen.add(key);
      result.models.push({ provider, id, ...(thinkingLevel ? { thinkingLevel } : {}) });
    }
  }
  return result;
}

export function saveMockModelScope(
  machine: MockMachine,
  patterns: string[],
  options: { cwd?: string; expectedPatterns: readonly string[] },
  touch: Touch,
): string {
  const file = scopeFile(machine, options.cwd);
  if (JSON.stringify(file.value.enabledModels ?? []) !== JSON.stringify(options.expectedPatterns)) {
    throw mockError("conflict", `${file.path} was modified externally`);
  }
  file.value.enabledModels = [...patterns];
  return touch(file);
}

function suffixAfter(pattern: string, ref: string): string | undefined {
  if (pattern === ref) return "";
  const suffix = pattern.slice(ref.length + 1) as NekThinkingLevel;
  return pattern.startsWith(`${ref}:`) && NEK_THINKING_LEVELS.includes(suffix)
    ? `:${suffix}`
    : undefined;
}

export function updateMockModelScope(
  machine: MockMachine,
  before: NekProviderConfig | undefined,
  after: NekProviderConfig | undefined,
  cwd: string | undefined,
  touch: Touch,
  previousId?: string,
): void {
  const effective = scopeFile(machine, cwd);
  const project = projectFile(machine, cwd);
  const files = project ? [machine.settings, project] : [machine.settings];
  const nextIds = new Set(after?.models.map(({ id }) => id));
  const oldIds = new Set(before?.models.map(({ id }) => id));
  const removed = before?.models.filter(({ id }) => !nextIds.has(id)) ?? [];
  const added = after?.models.filter(({ id }) => !oldIds.has(id)) ?? [];
  for (const file of files) {
    const patterns = file.value.enabledModels;
    if (!patterns?.length) continue;
    const next = patterns.flatMap((pattern) => {
      if (before && pattern.startsWith(`${before.id}/`) && before.id !== after?.id) {
        return after ? [`${after.id}${pattern.slice(before.id.length)}`] : [];
      }
      for (const { id } of removed) {
        const suffix = suffixAfter(pattern, `${before!.id}/${id}`);
        if (suffix === undefined) continue;
        return id === previousId && after && added[0]
          ? [`${after.id}/${added[0].id}${suffix}`]
          : [];
      }
      return [pattern];
    });
    if (after && (!before || before.id === after.id) && !previousId && file === effective) {
      for (const { id } of added) {
        const ref = `${after.id}/${id}`;
        if (!next.some((pattern) => suffixAfter(pattern, ref) !== undefined)) next.push(ref);
      }
    }
    if (JSON.stringify(patterns) !== JSON.stringify(next)) {
      file.value.enabledModels = next;
      touch(file);
    }
  }
}
