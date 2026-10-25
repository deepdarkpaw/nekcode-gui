/**
 * nek 动作快捷键的 React 桥接：用户覆盖存放在内存 store，生效表与 label 由此派生。
 *
 * 持久化不在这里：设置中心读取配置后调用 `setActionShortcutOverrides`，修改后自行写盘。
 */
import { useMemo } from "react";
import { create } from "zustand";
import {
  formatActionShortcut,
  resolveEffectiveActionBindings,
  type ActionShortcutOverrides,
  type EffectiveActionBindings,
} from "./actionRegistry.js";
import type { NekActionId } from "./nekActions.js";

interface ActionShortcutStore {
  overrides: ActionShortcutOverrides;
}

const useActionShortcutStore = create<ActionShortcutStore>(() => ({ overrides: {} }));

/** 替换用户覆盖（设置中心加载或保存后调用）。 */
export function setActionShortcutOverrides(overrides: ActionShortcutOverrides): void {
  useActionShortcutStore.setState({ overrides });
}

export function getActionShortcutOverrides(): ActionShortcutOverrides {
  return useActionShortcutStore.getState().overrides;
}

/** 当前生效的动作绑定表。 */
export function useEffectiveActionBindings(): EffectiveActionBindings {
  const overrides = useActionShortcutStore((state) => state.overrides);
  return useMemo(() => resolveEffectiveActionBindings(overrides), [overrides]);
}

/** 动作的平台展示 label（tooltip 用）；未设置返回空串。 */
export function useActionShortcutLabel(actionId: NekActionId): string {
  const effective = useEffectiveActionBindings();
  return formatActionShortcut(actionId, effective);
}
