/**
 * 模型编辑抽屉的编辑态与校验。
 */
import type { NekModelConfig, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import {
  thinkingDraftFromModel,
  thinkingFieldsFromDraft,
  enabledThinkingLevels,
  type ThinkingDraft,
} from "../../lib/thinkingLevels.js";

export const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type CostField = (typeof COST_FIELDS)[number];

export interface ModelDraft {
  id: string;
  name: string;
  /** 空字符串表示继承 provider.api；provider 没有 api 时保存前必须明确选择。 */
  api: string;
  contextWindow: number | undefined;
  contextValid: boolean;
  maxTokens: number | undefined;
  maxValid: boolean;
  image: boolean;
  thinking: ThinkingDraft;
  /** settings.modelThinkingLevels 中该模型的默认等级。 */
  defaultLevel: NekThinkingLevel | undefined;
  cost: Record<CostField, string>;
}

export type ModelDraftField =
  | "id"
  | "api"
  | "contextWindow"
  | "maxTokens"
  | "defaultLevel"
  | "cost";
export type ModelDraftErrors = Partial<Record<ModelDraftField, string>>;

export function modelDraftFrom(
  model: NekModelConfig | undefined,
  defaultLevel: NekThinkingLevel | undefined,
): ModelDraft {
  return {
    id: model?.id ?? "",
    name: model?.name ?? "",
    api: model?.api ?? "",
    contextWindow: model?.contextWindow,
    contextValid: true,
    maxTokens: model?.maxTokens,
    maxValid: true,
    image: model?.input?.includes("image") === true,
    thinking: thinkingDraftFromModel(model ?? {}),
    defaultLevel,
    cost: {
      input: model?.cost ? String(model.cost.input) : "",
      output: model?.cost ? String(model.cost.output) : "",
      cacheRead: model?.cost ? String(model.cost.cacheRead) : "",
      cacheWrite: model?.cost ? String(model.cost.cacheWrite) : "",
    },
  };
}

type Translate = (id: string, values?: Record<string, string | number>) => string;

function costValues(cost: ModelDraft["cost"]): Record<CostField, number> | null | "invalid" {
  const filled = COST_FIELDS.filter((field) => cost[field].trim() !== "");
  if (filled.length === 0) {
    return null;
  }
  const values = Object.fromEntries(
    COST_FIELDS.map((field) => [field, Number(cost[field].trim() || "0")]),
  );
  return Object.values(values).every((value) => Number.isFinite(value) && value >= 0)
    ? (values as Record<CostField, number>)
    : "invalid";
}

export function validateModelDraft(
  draft: ModelDraft,
  otherIds: ReadonlySet<string>,
  t: Translate,
  providerApi = "",
): ModelDraftErrors {
  const errors: ModelDraftErrors = {};
  const id = draft.id.trim();
  if (id === "") {
    errors.id = t("settings.nek.modelEditor.error.idRequired");
  } else if (otherIds.has(id)) {
    errors.id = t("settings.nek.modelEditor.error.idDuplicate");
  }
  if (providerApi.trim() === "" && draft.api.trim() === "") {
    errors.api = t("settings.nek.modelEditor.error.apiRequired");
  }
  if (!draft.contextValid) {
    errors.contextWindow = t("settings.nek.modelEditor.error.tokens");
  }
  if (!draft.maxValid) {
    errors.maxTokens = t("settings.nek.modelEditor.error.tokens");
  } else if (
    draft.maxTokens !== undefined &&
    draft.contextWindow !== undefined &&
    draft.maxTokens > draft.contextWindow
  ) {
    errors.maxTokens = t("settings.nek.modelEditor.error.maxExceedsContext");
  }
  if (draft.defaultLevel && !enabledThinkingLevels(draft.thinking).includes(draft.defaultLevel)) {
    errors.defaultLevel = t("settings.nek.modelEditor.error.defaultLevel");
  }
  if (costValues(draft.cost) === "invalid") {
    errors.cost = t("settings.nek.modelEditor.error.cost");
  }
  return errors;
}

/** 草稿 → 模型配置；保留原模型中 GUI 未编辑的字段（headers、compat、extra）。 */
export function modelConfigFromDraft(
  draft: ModelDraft,
  original: NekModelConfig | undefined,
): NekModelConfig {
  const cost = costValues(draft.cost);
  const thinking = thinkingFieldsFromDraft(draft.thinking);
  const config: NekModelConfig = {
    ...original,
    id: draft.id.trim(),
    name: draft.name.trim() || undefined,
    api: draft.api.trim() || undefined,
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
    input: draft.image ? ["text", "image"] : original?.input ? ["text"] : undefined,
    reasoning: thinking.reasoning || undefined,
    thinkingLevelMap: thinking.thinkingLevelMap,
    cost: cost && cost !== "invalid" ? cost : undefined,
  };
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as NekModelConfig;
}

export function isModelDraftDirty(draft: ModelDraft, initial: ModelDraft): boolean {
  const normalize = (value: ModelDraft) => ({
    ...value,
    thinking: { ...value.thinking, enabled: [...value.thinking.enabled].sort() },
  });
  return JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(initial));
}
