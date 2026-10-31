import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import { validateModelSelectionOptions, type ModelSelection } from "./registry.js";

/** 选择解析只需要“候选存在、等级受支持”这两条事实；来源可以是 nek 或任何 Catalog。 */
export interface ModelSelectionCandidateModel {
  readonly modelId: string;
  readonly reasoningLevels: readonly string[];
}

export interface ModelSelectionCandidateProvider {
  readonly providerId: string;
  readonly models: readonly ModelSelectionCandidateModel[];
}

export interface ModelSelectionCatalog {
  readonly providers: readonly ModelSelectionCandidateProvider[];
}

/**
 * 只解析未来执行的意图，不改原选择、持久记录或已固定请求。
 *
 * 原因：读取时清库会让临时失效永久丢失。找不到 provider/model 时给出失效结论，
 * 由调用方决定展示与清理；等级不受支持时保留 provider/model 身份，等待用户重新选择档位。
 */
export function resolveEffectiveModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly catalog: ModelSelectionCatalog;
}): EffectiveModelSelectionResult {
  const original = input.selection;
  if (!original)
    return Object.freeze({ effectiveSelection: null, selectionIssue: "selection-missing" });
  const provider = input.catalog.providers.find(
    (candidate) => candidate.providerId === original.providerId,
  );
  if (!provider) {
    return Object.freeze({ effectiveSelection: null, selectionIssue: "provider-not-found" });
  }
  const model = provider.models.find((candidate) => candidate.modelId === original.modelId);
  if (!model) return Object.freeze({ effectiveSelection: null, selectionIssue: "model-not-found" });
  const validation = validateModelSelectionOptions(model, original);
  const selection = Object.freeze({
    providerId: original.providerId,
    modelId: original.modelId,
    ...(validation.ok && original.options
      ? { options: Object.freeze({ ...original.options }) }
      : {}),
  });
  return Object.freeze({
    effectiveSelection: selection,
    ...(!validation.ok &&
    (validation.code === "reasoning-level-missing" ||
      validation.code === "reasoning-level-not-supported")
      ? { selectionIssue: validation.code }
      : {}),
  });
}
