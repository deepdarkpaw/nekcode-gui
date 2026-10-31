import type { ModelSelectionCatalog } from "./effective-model-selection.js";
import { validateModelSelectionOptions, type ModelSelection } from "./registry.js";

/**
 * 默认偏好来自事实来源自己的配置（nek：`settings.json` 的
 * `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `modelThinkingLevels`）。
 * 这里只做“偏好 → 可提交 Selection”的确定性收敛，不改写保存值。
 */
export interface ModelSelectionPreferences {
  readonly providerId?: string;
  readonly modelId?: string;
  /** 全局默认思考等级（nek `defaultThinkingLevel`）。 */
  readonly reasoningLevel?: string;
  /** 模型级思考等级（nek `modelThinkingLevels`）。优先于全局默认。 */
  readonly reasoningLevelFor?: (providerId: string, modelId: string) => string | undefined;
}

/**
 * Host 对全新草稿的初始推荐。偏好指向的模型不在目录里时退回目录顺序的第一条：
 * 默认偏好是可丢弃偏好，不是执行事实。
 */
export function resolveInitialModelSelection(input: {
  readonly catalog: ModelSelectionCatalog;
  readonly preferences?: ModelSelectionPreferences;
}): ModelSelection | undefined {
  const { catalog, preferences } = input;
  const target =
    findModel(catalog, preferences?.providerId, preferences?.modelId) ??
    findFirstSelectableModel(catalog);
  if (!target) return undefined;
  const requested =
    preferences?.reasoningLevelFor?.(target.providerId, target.modelId) ??
    preferences?.reasoningLevel;
  return freezeSelection({
    providerId: target.providerId,
    modelId: target.modelId,
    options: { reasoningLevel: preferredLevel(target.reasoningLevels, requested) },
  });
}

/** 仅在用户主动选模型或全新初始化时构造最高档；不能用于恢复/重解析已有选择。 */
export function completeNewModelSelection(
  catalog: ModelSelectionCatalog,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = findModel(catalog, selection.providerId, selection.modelId);
  const reasoningLevel = model?.reasoningLevels.at(-1);
  if (!reasoningLevel) return undefined;
  return freezeSelection({
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  });
}

/** 调用方已经显式给出档位时只确认它仍然受支持；不支持时保留模型身份等待重选。 */
export function normalizeModelSelection(
  catalog: ModelSelectionCatalog,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = findModel(catalog, selection.providerId, selection.modelId);
  if (!model) return undefined;
  return validateModelSelectionOptions(model, selection).ok
    ? freezeSelection(selection)
    : freezeSelection({ providerId: selection.providerId, modelId: selection.modelId });
}

interface CatalogModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevels: readonly string[];
}

/** 请求的档位受支持就用它；否则用模型支持的最高档（与旧版初始推荐一致）。 */
function preferredLevel(levels: readonly string[], requested: string | undefined): string {
  if (requested !== undefined && levels.includes(requested)) return requested;
  return levels[levels.length - 1]!;
}

function findModel(
  catalog: ModelSelectionCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): CatalogModel | undefined {
  if (!providerId || !modelId) return undefined;
  const provider = catalog.providers.find((candidate) => candidate.providerId === providerId);
  const model = provider?.models.find((candidate) => candidate.modelId === modelId);
  return model && model.reasoningLevels.length > 0
    ? { providerId, modelId, reasoningLevels: model.reasoningLevels }
    : undefined;
}

function findFirstSelectableModel(catalog: ModelSelectionCatalog): CatalogModel | undefined {
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (model.reasoningLevels.length > 0) {
        return {
          providerId: provider.providerId,
          modelId: model.modelId,
          reasoningLevels: model.reasoningLevels,
        };
      }
    }
  }
  return undefined;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}
