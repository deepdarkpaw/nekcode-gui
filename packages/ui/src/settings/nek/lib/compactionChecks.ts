/**
 * 压缩设置的组合检查：nek 遇到不兼容的组合会直接报错，不会自动退回主模型，
 * 所以设置页在用户选择后立即提示。
 */
import type { NekCatalogModel, NekSettingsView } from "@zcode/shared/nek-protocol";
import { findCatalogModel, formatModelRef, supportedThinkingLevels } from "./modelRef.js";

export type CompactionIssue =
  | { kind: "modelMissing"; severity: "error"; model: string }
  | { kind: "thinkingUnsupported"; severity: "error"; level: string; model: string }
  | { kind: "reserveExceedsContext"; severity: "error"; reserve: number; contextWindow: number }
  | {
      kind: "smallerContext";
      severity: "warning";
      model: string;
      contextWindow: number;
      mainContextWindow: number;
    };

/** 主模型引用：`defaultProvider/defaultModel`；未设置返回 undefined。 */
export function mainModelRef(settings: NekSettingsView): string | undefined {
  if (!settings.defaultProvider || !settings.defaultModel) {
    return undefined;
  }
  return formatModelRef(settings.defaultProvider, settings.defaultModel);
}

export function checkCompaction(
  settings: NekSettingsView,
  models: readonly NekCatalogModel[],
  defaults: NekSettingsView,
): CompactionIssue[] {
  const issues: CompactionIssue[] = [];
  const compaction = settings.compaction ?? {};
  const mainRef = mainModelRef(settings);
  const main = findCatalogModel(models, mainRef);
  const modelRef = compaction.model ?? mainRef;
  const model = compaction.model ? findCatalogModel(models, compaction.model) : main;

  if (compaction.model && !model) {
    issues.push({ kind: "modelMissing", severity: "error", model: compaction.model });
  }
  const level = compaction.thinkingLevel;
  if (level && model && modelRef && !supportedThinkingLevels(model).includes(level)) {
    issues.push({ kind: "thinkingUnsupported", severity: "error", level, model: modelRef });
  }
  const reserve = compaction.reserveTokens ?? defaults.compaction?.reserveTokens;
  if (reserve !== undefined && model && reserve >= model.contextWindow) {
    issues.push({
      kind: "reserveExceedsContext",
      severity: "error",
      reserve,
      contextWindow: model.contextWindow,
    });
  }
  if (compaction.model && model && main && model.contextWindow < main.contextWindow) {
    issues.push({
      kind: "smallerContext",
      severity: "warning",
      model: compaction.model,
      contextWindow: model.contextWindow,
      mainContextWindow: main.contextWindow,
    });
  }
  return issues;
}
