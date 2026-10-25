/**
 * 模型引用 `provider/id`：模型 ID 自身可能含 `/`（如 openrouter 的 `anthropic/claude-sonnet-4`），
 * 因此只按第一个 `/` 切分。
 */
import type { NekCatalogModel, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";

export interface ModelRef {
  provider: string;
  id: string;
}

export function formatModelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export function parseModelRef(ref: string): ModelRef | null {
  const index = ref.indexOf("/");
  if (index <= 0 || index === ref.length - 1) {
    return null;
  }
  return { provider: ref.slice(0, index), id: ref.slice(index + 1) };
}

export function findCatalogModel(
  models: readonly NekCatalogModel[],
  ref: string | undefined,
): NekCatalogModel | undefined {
  const parsed = ref ? parseModelRef(ref) : null;
  if (!parsed) {
    return undefined;
  }
  return models.find((model) => model.provider === parsed.provider && model.id === parsed.id);
}

/** 模型支持的思考等级（按标准顺序）；不支持思考时只有 off。 */
export function supportedThinkingLevels(model: NekCatalogModel | undefined): NekThinkingLevel[] {
  if (!model) {
    return [...NEK_THINKING_LEVELS];
  }
  if (!model.reasoning || model.thinkingLevels.length === 0) {
    return ["off"];
  }
  return NEK_THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level));
}

/** 按服务商分组（保持首次出现顺序）。 */
export function groupModelsByProvider(
  models: readonly NekCatalogModel[],
): Array<{ provider: string; models: NekCatalogModel[] }> {
  const groups = new Map<string, NekCatalogModel[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}
