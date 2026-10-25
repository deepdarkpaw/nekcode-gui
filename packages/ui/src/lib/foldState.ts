/**
 * 折叠状态 store：按行 ID 记录单项覆盖（有界 LRU），并提供分组全局开关。
 *
 * 交互规范 §7.4：
 * - Ctrl+O 切换全部工具输出、Ctrl+T 切换全部 thinking；全局切换会清除该组的单项覆盖；
 * - 手动点过的单项保持自己的状态，直到下一次全局切换；
 * - 状态存于模块级内存，流式重渲染、虚拟列表回收、切回会话后都不会丢。
 */
import { useCallback } from "react";
import { create } from "zustand";

/** 参与全局切换的分组；null 表示不参与全局切换（用户消息、代码块、设置分组等）。 */
export type FoldGroup = "toolOutput" | "thinking";

/** 单项覆盖条目上限（有界内存）。 */
export const FOLD_OVERRIDE_LIMIT = 2000;

interface FoldOverride {
  group: FoldGroup | null;
  open: boolean;
}

/** 分组模式：null = 各项使用自身默认值（如出错的工具卡默认展开）；布尔值 = 全局强制。 */
type FoldGroupModes = Readonly<Record<FoldGroup, boolean | null>>;

export interface FoldSnapshot {
  readonly overrides: ReadonlyMap<string, FoldOverride>;
  readonly groupModes: FoldGroupModes;
}

export const EMPTY_FOLD_SNAPSHOT: FoldSnapshot = {
  overrides: new Map(),
  groupModes: { toolOutput: null, thinking: null },
};

/** 计算某一项的生效展开状态：单项覆盖 > 分组全局模式 > 调用方默认值。 */
export function resolveFoldOpen(
  snapshot: FoldSnapshot,
  id: string,
  group: FoldGroup | null,
  defaultOpen: boolean,
): boolean {
  const override = snapshot.overrides.get(id);
  if (override) {
    return override.open;
  }
  const mode = group === null ? null : snapshot.groupModes[group];
  return mode ?? defaultOpen;
}

/** 写入单项覆盖；最近写入的移到末尾，超过上限淘汰最旧条目。 */
export function setFoldOverride(
  snapshot: FoldSnapshot,
  id: string,
  group: FoldGroup | null,
  open: boolean,
  limit = FOLD_OVERRIDE_LIMIT,
): FoldSnapshot {
  const overrides = new Map(snapshot.overrides);
  overrides.delete(id);
  overrides.set(id, { group, open });
  for (const oldestId of overrides.keys()) {
    if (overrides.size <= limit) {
      break;
    }
    overrides.delete(oldestId);
  }
  return { ...snapshot, overrides };
}

/** 设置分组全局模式，并清除该组全部单项覆盖。 */
export function setFoldGroupMode(
  snapshot: FoldSnapshot,
  group: FoldGroup,
  open: boolean,
): FoldSnapshot {
  const overrides = new Map(
    [...snapshot.overrides].filter(([, override]) => override.group !== group),
  );
  return { overrides, groupModes: { ...snapshot.groupModes, [group]: open } };
}

/** 全局切换：未切换过的分组视为折叠，第一次切换为全部展开。 */
export function toggleFoldGroupMode(snapshot: FoldSnapshot, group: FoldGroup): FoldSnapshot {
  return setFoldGroupMode(snapshot, group, !(snapshot.groupModes[group] ?? false));
}

interface FoldStore extends FoldSnapshot {
  setOpen: (id: string, group: FoldGroup | null, open: boolean) => void;
  setGroupOpen: (group: FoldGroup, open: boolean) => void;
  toggleGroup: (group: FoldGroup) => void;
  reset: () => void;
}

/** 全局折叠状态 store（模块级单例）。 */
export const useFoldStore = create<FoldStore>((set) => ({
  ...EMPTY_FOLD_SNAPSHOT,
  setOpen: (id, group, open) => set((state) => setFoldOverride(state, id, group, open)),
  setGroupOpen: (group, open) => set((state) => setFoldGroupMode(state, group, open)),
  toggleGroup: (group) => set((state) => toggleFoldGroupMode(state, group)),
  reset: () => set(EMPTY_FOLD_SNAPSHOT),
}));

/**
 * 读取并修改某一行的折叠状态。
 * 返回 `[open, setOpen]`，可直接接到 `<Fold open onOpenChange>`。
 */
export function useFoldState(
  id: string,
  group: FoldGroup | null,
  defaultOpen: boolean,
): readonly [boolean, (open: boolean) => void] {
  const open = useFoldStore((state) => resolveFoldOpen(state, id, group, defaultOpen));
  const setStoreOpen = useFoldStore((state) => state.setOpen);
  const setOpen = useCallback(
    (next: boolean) => setStoreOpen(id, group, next),
    [setStoreOpen, id, group],
  );
  return [open, setOpen] as const;
}
