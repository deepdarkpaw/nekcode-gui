/**
 * nekcode-gui 自身的新增界面偏好（沿用 nekcode 的 localStorage 偏好存储机制）：
 * 发送键、thinking 默认折叠、工具输出默认展开、Mermaid、分类系统通知、nek 动作快捷键覆盖。
 * 主题 / 字号 / 语言 / 通知总开关继续使用现有的 store。
 */
import { create } from "zustand";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { setActionShortcutOverrides } from "@/shortcuts/useActionShortcuts.js";
import type { ActionShortcutOverrides } from "@/shortcuts/actionRegistry.js";
import { isNekActionId } from "@/shortcuts/nekActions.js";

export const GUI_PREFERENCES_STORAGE_KEY = "nekcode-gui-preferences";

export type SendKey = "enter" | "ctrlEnter";

export interface NekGuiPreferences {
  sendKey: SendKey;
  thinkingCollapsed: boolean;
  toolOutputExpanded: boolean;
  mermaid: boolean;
  notify: { turnComplete: boolean; needsInput: boolean; error: boolean };
  actionShortcutOverrides: ActionShortcutOverrides;
}

export const DEFAULT_GUI_PREFERENCES: NekGuiPreferences = {
  sendKey: "enter",
  thinkingCollapsed: true,
  toolOutputExpanded: false,
  mermaid: true,
  notify: { turnComplete: true, needsInput: true, error: true },
  actionShortcutOverrides: {},
};

function sanitizeOverrides(value: unknown): ActionShortcutOverrides {
  if (typeof value !== "object" || value === null) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string[]] =>
      isNekActionId(entry[0]) &&
      Array.isArray(entry[1]) &&
      entry[1].every((item) => typeof item === "string"),
  );
  return Object.fromEntries(entries) as ActionShortcutOverrides;
}

/** 读取并与默认值合并；字段类型不对时用默认值（不吞掉其余合法字段）。 */
export function parseGuiPreferences(raw: string | null): NekGuiPreferences {
  if (!raw) return DEFAULT_GUI_PREFERENCES;
  let parsed: Partial<NekGuiPreferences>;
  try {
    parsed = JSON.parse(raw) as Partial<NekGuiPreferences>;
  } catch {
    return DEFAULT_GUI_PREFERENCES;
  }
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  const notify: Partial<NekGuiPreferences["notify"]> = parsed.notify ?? {};
  return {
    sendKey: parsed.sendKey === "ctrlEnter" ? "ctrlEnter" : "enter",
    thinkingCollapsed: bool(parsed.thinkingCollapsed, DEFAULT_GUI_PREFERENCES.thinkingCollapsed),
    toolOutputExpanded: bool(parsed.toolOutputExpanded, DEFAULT_GUI_PREFERENCES.toolOutputExpanded),
    mermaid: bool(parsed.mermaid, DEFAULT_GUI_PREFERENCES.mermaid),
    notify: {
      turnComplete: bool(notify.turnComplete, true),
      needsInput: bool(notify.needsInput, true),
      error: bool(notify.error, true),
    },
    actionShortcutOverrides: sanitizeOverrides(parsed.actionShortcutOverrides),
  };
}

interface GuiPreferencesStore {
  preferences: NekGuiPreferences;
  update: (patch: Partial<NekGuiPreferences>) => void;
}

const initial = parseGuiPreferences(readSafeLocalStorage(GUI_PREFERENCES_STORAGE_KEY));
setActionShortcutOverrides(initial.actionShortcutOverrides);

export const useNekGuiPreferences = create<GuiPreferencesStore>((set, get) => ({
  preferences: initial,
  update: (patch) => {
    const preferences = { ...get().preferences, ...patch };
    writeSafeLocalStorage(GUI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    if (patch.actionShortcutOverrides) {
      setActionShortcutOverrides(patch.actionShortcutOverrides);
    }
    set({ preferences });
  },
}));
