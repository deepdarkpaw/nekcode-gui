import type { ModelSelection } from "./model-selection.js";
import type { EffectiveModelSelectionResult } from "./model-selection.js";

export type { EffectiveModelSelectionResult } from "./model-selection.js";

export type ModelSelectionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "provider-not-found";
      readonly providerId: string;
    }
  | {
      readonly ok: false;
      readonly code: "model-not-found";
      readonly providerId: string;
      readonly modelId: string;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-missing";
      readonly providerId: string;
      readonly modelId: string;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-not-supported";
      readonly providerId: string;
      readonly modelId: string;
      readonly reasoningLevel: string;
      readonly supportedLevels: readonly string[];
    };

export interface ModelSelectionCandidateModel {
  readonly modelId: string;
  readonly reasoningLevels: readonly string[];
  /** 事实来源给出的该模型默认档位（已按来源规则夹到受支持等级）。 */
  readonly defaultReasoningLevel?: string;
}

export interface ModelSelectionCandidateProvider {
  readonly providerId: string;
  readonly models: readonly ModelSelectionCandidateModel[];
}

export interface ModelSelectionCatalog {
  readonly providers: readonly ModelSelectionCandidateProvider[];
}

export interface ModelSelectionModelView {
  readonly modelId: string;
  readonly displayName: string;
  /** 模型支持的思考等级（低→高），来自事实来源自己的判定。 */
  readonly reasoningLevels: readonly string[];
  /** 事实来源给出的该模型默认思考等级。 */
  readonly defaultReasoningLevel?: string;
  readonly supportsImage: boolean;
}

/** 选择候选服务商。只承载选择与展示事实，不携带端点、凭证或 Registry 配置。 */
export interface ModelSelectionProviderView {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly ModelSelectionModelView[];
}

export interface ModelSelectionViewInput {
  readonly selection: ModelSelection | null;
  /** 目标机器上的 workspace 根目录，事实来源按它合并项目级默认值。 */
  readonly workspacePath?: string;
}

export type ModelSelectionPreferredIssue = "configured-default-unavailable";

export interface ModelSelectionView extends Partial<EffectiveModelSelectionResult> {
  /** Catalog identity only: excludes workspace defaults. Not a readiness/recovery token. */
  readonly revision: number;
  readonly providers: readonly ModelSelectionProviderView[];
  readonly preferredSelection?: ModelSelection;
  /** 配置里的显式默认模型不可用，调用方必须让用户重新选择。 */
  readonly preferredSelectionIssue?: ModelSelectionPreferredIssue;
}

/** 默认选择、选择解析与提交门禁共用同一套 Model Option 校验。 */
export function validateModelSelectionOptions(
  model: { readonly reasoningLevels: readonly string[] },
  selection: ModelSelection,
): ModelSelectionValidation {
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel === undefined) {
    return {
      ok: false,
      code: "reasoning-level-missing",
      providerId: selection.providerId,
      modelId: selection.modelId,
    };
  }
  if (!model.reasoningLevels.includes(reasoningLevel)) {
    return {
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningLevel,
      supportedLevels: Object.freeze([...model.reasoningLevels]),
    };
  }
  return { ok: true };
}

/** 只解析未来执行的意图，不改原选择、持久记录或已固定请求。 */
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

export type ModelSelectionPreferredModel = Readonly<{
  providerId: string;
  modelId: string;
}>;

export interface InitialModelSelectionResolution {
  readonly selection?: ModelSelection;
  readonly issue?: ModelSelectionPreferredIssue;
  /** 推荐来源：显式默认 / 目录顺序的确定性首选 / 无可用模型。 */
  readonly source: "configured-default" | "catalog-default" | "none";
}

/** Host 对全新草稿的初始推荐。 */
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

/** 用户主动选模型时补上该模型自己的默认档位。 */
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

interface CatalogModel extends ModelSelectionCandidateModel {
  readonly providerId: string;
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
