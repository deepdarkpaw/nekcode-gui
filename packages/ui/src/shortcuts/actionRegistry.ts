/**
 * nek 动作快捷键注册表：生效表（默认 + 用户覆盖）、冲突检测、事件匹配、展示 label。
 *
 * 覆盖语义与现有命令表一致（bindings.ts resolveEffectiveShortcutBindings）：
 * 按动作整组替换；显式空数组 = 用户清除为「未设置」；条目全部非法时回退默认。
 */
import type { EffectiveShortcutBindings, ShortcutBindingEvent } from "./bindings.js";
import type { KeyboardShortcutPlatformInfo } from "@/lib/keyboardShortcuts.js";
import {
  formatActionBindingLabel,
  isSameActionBinding,
  isValidActionBinding,
  matchesActionBinding,
} from "./actionBinding.js";
import {
  NEK_ACTIONS,
  getNekAction,
  isNekActionId,
  type NekActionId,
  type NekActionScope,
} from "./nekActions.js";

export type ActionShortcutOverrides = Readonly<Partial<Record<NekActionId, readonly string[]>>>;
export type EffectiveActionBindings = Readonly<Record<NekActionId, readonly string[]>>;

/** 合并默认绑定与用户覆盖。未知动作 id 被忽略。 */
export function resolveEffectiveActionBindings(
  overrides: Readonly<Record<string, readonly string[] | undefined>> = {},
): EffectiveActionBindings {
  const entries = NEK_ACTIONS.map((action) => {
    const override = overrides[action.id];
    if (override === undefined) {
      return [action.id, action.defaultBindings] as const;
    }
    if (override.length === 0) {
      return [action.id, override] as const;
    }
    const valid = override.filter(isValidActionBinding);
    return [action.id, valid.length > 0 ? valid : action.defaultBindings] as const;
  });
  return Object.fromEntries(entries) as EffectiveActionBindings;
}

/** 编辑类原生行为与刷新/开发工具：动作不得占用。 */
const RESERVED_ACTION_BINDINGS: readonly string[] = [
  ...["c", "v", "x", "z", "a", "y"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
];

/** 两个作用域是否会同时生效：同作用域或任一方为全局。 */
function scopesOverlap(a: NekActionScope, b: NekActionScope): boolean {
  return a === b || a === "global" || b === "global";
}

export type ActionBindingConflict =
  | { kind: "invalid"; binding: string }
  | { kind: "reserved"; binding: string }
  | { kind: "occupied"; binding: string; ownerActionId: NekActionId };

/**
 * 把 binding 绑定到 actionId 是否冲突；null 表示可以绑定。
 * 物理等价（Windows 上 Ctrl+l ≡ CmdOrCtrl+l）视为同一组合。
 */
export function checkActionBindingConflict(
  actionId: NekActionId,
  binding: string,
  effective: EffectiveActionBindings,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ActionBindingConflict | null {
  if (!isValidActionBinding(binding)) {
    return { kind: "invalid", binding };
  }
  if (
    RESERVED_ACTION_BINDINGS.some((reserved) =>
      isSameActionBinding(reserved, binding, platformInfo),
    )
  ) {
    return { kind: "reserved", binding };
  }
  const scope = getNekAction(actionId).scope;
  for (const other of NEK_ACTIONS) {
    if (other.id === actionId || !scopesOverlap(scope, other.scope)) {
      continue;
    }
    if (effective[other.id].some((bound) => isSameActionBinding(bound, binding, platformInfo))) {
      return { kind: "occupied", binding, ownerActionId: other.id };
    }
  }
  return null;
}

export interface ActionConflictGroup {
  binding: string;
  actionIds: readonly NekActionId[];
}

/** 列出生效表中所有冲突（快捷键页标红用）。每组至少两个动作。 */
export function findActionConflicts(
  effective: EffectiveActionBindings,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ActionConflictGroup[] {
  const groups: { binding: string; actionIds: NekActionId[] }[] = [];
  for (const action of NEK_ACTIONS) {
    for (const binding of effective[action.id]) {
      const group = groups.find(
        (candidate) =>
          isSameActionBinding(candidate.binding, binding, platformInfo) &&
          candidate.actionIds.some((id) => scopesOverlap(getNekAction(id).scope, action.scope)),
      );
      if (!group) {
        groups.push({ binding, actionIds: [action.id] });
      } else if (!group.actionIds.includes(action.id)) {
        group.actionIds.push(action.id);
      }
    }
  }
  return groups.filter((group) => group.actionIds.length > 1);
}

export interface LegacyCommandConflict {
  actionId: NekActionId;
  commandId: string;
  binding: string;
}

/**
 * 迁移期：动作与现有 ZCode 命令表（非 composer 作用域视为全局）之间的物理冲突。
 * 动作自身对应的 legacyCommandId 不算冲突。
 */
export function findLegacyCommandConflicts(
  effective: EffectiveActionBindings,
  legacy: EffectiveShortcutBindings,
  platformInfo?: KeyboardShortcutPlatformInfo,
): LegacyCommandConflict[] {
  const conflicts: LegacyCommandConflict[] = [];
  for (const action of NEK_ACTIONS) {
    for (const [commandId, bindings] of Object.entries(legacy)) {
      if (commandId === action.legacyCommandId) {
        continue;
      }
      const binding = effective[action.id].find((bound) =>
        bindings.some((legacyBinding) => isSameActionBinding(bound, legacyBinding, platformInfo)),
      );
      if (binding !== undefined) {
        conflicts.push({ actionId: action.id, commandId, binding });
      }
    }
  }
  return conflicts;
}

/**
 * 按事件找到命中的动作（只在给定作用域内查找；composer 聚焦时调用方先查 composer 再查 global）。
 */
export function matchActionEvent(
  event: ShortcutBindingEvent,
  effective: EffectiveActionBindings,
  scope: NekActionScope,
  platformInfo?: KeyboardShortcutPlatformInfo,
): NekActionId | null {
  for (const action of NEK_ACTIONS) {
    if (action.scope !== scope) {
      continue;
    }
    if (
      effective[action.id].some((binding) => matchesActionBinding(event, binding, platformInfo))
    ) {
      return action.id;
    }
  }
  return null;
}

/** 动作的展示 label（首个生效绑定）；未设置返回空串。 */
export function formatActionShortcut(
  actionId: NekActionId,
  effective: EffectiveActionBindings,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const first = effective[actionId][0];
  return first === undefined ? "" : formatActionBindingLabel(first, platformInfo);
}

// ============================================================================
// nek keybindings.json 导入
// ============================================================================

const NEK_KEY_NAMES: Readonly<Record<string, string>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
};

const NEK_MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: "CmdOrCtrl",
  alt: "Alt",
  shift: "Shift",
};

/** 绑定串修饰键的规范顺序（与 shared serializeShortcutBinding 一致）。 */
const MODIFIER_ORDER = ["CmdOrCtrl", "Ctrl", "Alt", "Shift", "AltGr"];

/**
 * nek 键位（如 `ctrl+shift+up`、`alt+enter`、`shift+tab`）→ 动作绑定串。
 * 终端 ctrl 映射为桌面 CmdOrCtrl；无法表达的键返回 null。
 */
export function fromNekKeyId(keyId: string): string | null {
  const tokens = keyId.toLowerCase().split("+");
  const rawKey = tokens.pop();
  if (rawKey === undefined || rawKey === "") {
    return null;
  }
  const modifiers: string[] = [];
  for (const token of tokens) {
    const modifier = NEK_MODIFIERS[token];
    if (modifier === undefined) {
      return null;
    }
    modifiers.push(modifier);
  }
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const key =
    NEK_KEY_NAMES[rawKey] ?? (/^f([1-9]|1[0-2])$/.test(rawKey) ? rawKey.toUpperCase() : rawKey);
  const binding = [...modifiers, key].join("+");
  return isValidActionBinding(binding) ? binding : null;
}

export interface NekKeybindingsImport {
  overrides: ActionShortcutOverrides;
  /** 无法转换的条目（动作 id + 原始键位），需要在界面上告知用户。 */
  unsupported: readonly { actionId: string; keyId: string }[];
}

/** 导入 nek `keybindings.json`：只取 GUI 支持的动作，其余动作 id 忽略。 */
export function importNekKeybindings(
  config: Readonly<Record<string, string | readonly string[]>>,
): NekKeybindingsImport {
  const overrides: Partial<Record<NekActionId, readonly string[]>> = {};
  const unsupported: { actionId: string; keyId: string }[] = [];
  for (const [actionId, value] of Object.entries(config)) {
    if (!isNekActionId(actionId)) {
      continue;
    }
    const keyIds = typeof value === "string" ? [value] : value;
    const bindings: string[] = [];
    for (const keyId of keyIds) {
      const binding = fromNekKeyId(keyId);
      if (binding === null) {
        unsupported.push({ actionId, keyId });
      } else {
        bindings.push(binding);
      }
    }
    // 显式空数组 = 未设置；全部无法转换时保留默认键（已记入 unsupported 告知用户）。
    if (keyIds.length === 0 || bindings.length > 0) {
      overrides[actionId] = bindings;
    }
  }
  return { overrides, unsupported };
}
