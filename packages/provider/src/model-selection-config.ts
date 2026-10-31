import type { ModelSelectionCatalog } from "./effective-model-selection.js";
import { validateModelSelectionOptions, type ModelSelection } from "./registry.js";

/**
 * 事实来源的显式默认不可用（例如 settings.json 里的 defaultProvider/defaultModel 已从目录消失）。
 *
 * 这时不给首选模型，也不静默换成别的服务商：调用方要让用户重新选择。nek 自己在启动回合时
 * 会回落到首个可用模型（`resolveModelFromSettings`），但那是 CLI 的隐式行为，GUI 不复制它。
 */
export type ModelSelectionPreferredIssue = "configured-default-unavailable";

export interface ModelSelectionPreferredModel {
  readonly providerId: string;
  readonly modelId: string;
}

export interface InitialModelSelectionResolution {
  readonly selection?: ModelSelection;
  readonly issue?: ModelSelectionPreferredIssue;
  /** 这次推荐的来源：显式默认（含项目级覆盖）/ 目录顺序的确定性首选 / 无可用模型。 */
  readonly source: "configured-default" | "catalog-default" | "none";
}

/**
 * Host 对全新草稿的初始推荐。
 *
 * - 配置里有显式默认：只接受它；不可用时给出 `configured-default-unavailable`，不换成别的服务商。
 * - 没有显式默认：按目录顺序取第一条有思考等级的模型（确定性首选，归属 `catalog-default`）。
 *
 * 思考等级取自模型自己的 `defaultReasoningLevel`（事实来源已按自己的规则夹到受支持等级）。
 */
export function resolveInitialModelSelection(input: {
  readonly catalog: ModelSelectionCatalog;
  readonly configuredDefault?: ModelSelectionPreferredModel;
}): InitialModelSelectionResolution {
  const { catalog, configuredDefault } = input;
  if (configuredDefault) {
    const model = findModel(catalog, configuredDefault.providerId, configuredDefault.modelId);
    if (!model?.defaultReasoningLevel) {
      return { issue: "configured-default-unavailable", source: "configured-default" };
    }
    return {
      selection: freezeSelection({
        providerId: configuredDefault.providerId,
        modelId: configuredDefault.modelId,
        options: { reasoningLevel: model.defaultReasoningLevel },
      }),
      source: "configured-default",
    };
  }
  const first = findFirstSelectableModel(catalog);
  if (!first) return { source: "none" };
  return {
    selection: freezeSelection({
      providerId: first.providerId,
      modelId: first.modelId,
      options: { reasoningLevel: first.defaultReasoningLevel },
    }),
    source: "catalog-default",
  };
}

/**
 * 用户主动选模型时的完整选择：只确定模型身份与它自己的默认档位。
 * 之后用户仍可从该模型的 `reasoningLevels` 里改档位。
 */
export function completeNewModelSelection(
  catalog: ModelSelectionCatalog,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = findModel(catalog, selection.providerId, selection.modelId);
  if (!model?.defaultReasoningLevel) return undefined;
  return freezeSelection({
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel: model.defaultReasoningLevel },
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
  readonly defaultReasoningLevel?: string;
}

function findModel(
  catalog: ModelSelectionCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): CatalogModel | undefined {
  if (!providerId || !modelId) return undefined;
  const provider = catalog.providers.find((candidate) => candidate.providerId === providerId);
  const model = provider?.models.find((candidate) => candidate.modelId === modelId);
  return model ? { ...model, providerId, modelId } : undefined;
}

function findFirstSelectableModel(catalog: ModelSelectionCatalog): CatalogModel | undefined {
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (!model.defaultReasoningLevel) continue;
      return { ...model, providerId: provider.providerId };
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
