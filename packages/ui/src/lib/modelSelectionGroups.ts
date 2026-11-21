import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

/**
 * Selection View → 模型菜单分组。
 *
 * View 的候选已经是事实来源的最终答案（nek：可用性与模型目录的交集），这里不再按
 * 端点协议、账号套餐或 Registry 可见性二次过滤——那会把“nek 能跑的模型”从菜单里删掉。
 */
export function buildModelSelectGroups(view: ModelSelectionView): ModelSelectGroup[] {
  return view.providers.map((provider) => ({
    key: `provider:${provider.providerId}`,
    label: provider.displayName || provider.providerId,
    items: provider.models.map((model) => ({
      key: `provider:${provider.providerId}:${model.modelId}`,
      value: encodeCustomModelValue(provider.providerId, model.modelId),
      name: model.displayName || model.modelId,
      ...(model.supportsImage ? { supportsVisionInput: true } : {}),
    })),
  }));
}

/** 单一分组保留 nek 的原始顺序，不能按服务商再次聚合。 */
export function buildScopedModelSelectGroups(
  scope: ModelSelectionView["scope"],
  allGroups: readonly ModelSelectGroup[],
): ModelSelectGroup[] {
  const byValue = new Map(
    allGroups.flatMap((group) => group.items.map((item) => [item.value, item] as const)),
  );
  const items = scope.models.flatMap(({ provider, id }) => {
    const item = byValue.get(encodeCustomModelValue(provider, id));
    return item ? [{ ...item, badgeLabel: provider }] : [];
  });
  return items.length ? [{ key: "scoped", label: "", items }] : [];
}

export function findModelSelectItem(
  groups: readonly ModelSelectGroup[],
  value: string,
): ModelSelectGroupItem | undefined {
  for (const group of groups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched;
  }
  return undefined;
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  return (
    findModelSelectItem(modelGroups, value)?.name ??
    decodeCustomModelValue(value)?.modelName ??
    null
  );
}
