/**
 * settings.json 补丁：与 nek SettingsManager 一致的"按键合并"语义。
 *
 * - 顶层 `null` 删除该键（恢复默认）；
 * - 嵌套对象逐键合并，嵌套 `null` 同样删除对应子键。
 *
 * 契约里的 `NekSettingsPatch` 只允许顶层 `null`；删除嵌套子键（例如 `compaction.model` 的
 * "跟随主模型"）需要嵌套 `null`，见 `nestedSettingsPatch`（已在报告中建议扩充契约）。
 */
import type { NekSettingsPatch, NekSettingsView } from "@zcode/shared/nek-protocol";

type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归合并补丁；返回新对象，不修改输入。 */
export function mergeDeep(target: PlainObject, patch: PlainObject): PlainObject {
  const next: PlainObject = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[key];
      continue;
    }
    const current = next[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      const merged = mergeDeep(current, value);
      if (Object.keys(merged).length === 0) {
        delete next[key];
      } else {
        next[key] = merged;
      }
      continue;
    }
    next[key] = isPlainObject(value) ? mergeDeep({}, value) : value;
  }
  return next;
}

export function applySettingsPatch(
  view: NekSettingsView,
  patch: NekSettingsPatch,
): NekSettingsView {
  return mergeDeep(view as PlainObject, patch as PlainObject) as NekSettingsView;
}

/** 嵌套补丁：允许子键为 null（删除）。 */
export type NestedSettingsPatch = {
  [K in keyof NekSettingsView]?:
    | null
    | (NonNullable<NekSettingsView[K]> extends readonly unknown[]
        ? NekSettingsView[K]
        : NonNullable<NekSettingsView[K]> extends object
          ? {
              [F in keyof NonNullable<NekSettingsView[K]>]?:
                | NonNullable<NekSettingsView[K]>[F]
                | null;
            }
          : NekSettingsView[K]);
};

/**
 * 嵌套 `null` 的唯一出口：契约类型尚未表达嵌套删除，这里集中做一次类型收窄。
 * 后端实现须按 `mergeDeep` 语义处理嵌套 `null`（删除子键），不能把 null 原样写进文件。
 */
export function nestedSettingsPatch(patch: NestedSettingsPatch): NekSettingsPatch {
  return patch as NekSettingsPatch;
}

/**
 * 原始 JSON 编辑：before → after 的最小补丁（删除的键为 null，嵌套对象递归）。
 * 数组与基础值整体替换。
 */
export function diffSettingsValues(before: PlainObject, after: PlainObject): PlainObject {
  const patch: PlainObject = {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      patch[key] = null;
    }
  }
  for (const [key, value] of Object.entries(after)) {
    const previous = before[key];
    if (isPlainObject(previous) && isPlainObject(value)) {
      const nested = diffSettingsValues(previous, value);
      if (Object.keys(nested).length > 0) {
        patch[key] = nested;
      }
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      patch[key] = value;
    }
  }
  return patch;
}

/** 视图（含 extra）→ 原始 JSON 对象：extra 里的键平铺回顶层。 */
export function settingsViewToJson(view: NekSettingsView): PlainObject {
  const { extra, ...known } = view;
  return { ...known, ...extra };
}

const KNOWN_SETTINGS_KEYS = new Set<string>([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "modelThinkingLevels",
  "enabledModels",
  "defaultTools",
  "shellPath",
  "shellCommandPrefix",
  "compaction",
  "branchSummary",
  "retry",
  "webSearch",
  "httpProxy",
  "httpIdleTimeoutMs",
  "transport",
  "steeringMode",
  "followUpMode",
  "defaultProjectTrust",
  "hideThinkingBlock",
  "updateChannel",
]);

/** 原始 JSON 对象 → 视图形状（未知键进 extra）。 */
export function jsonToSettingsView(json: PlainObject): NekSettingsView {
  const view: PlainObject = {};
  const extra: PlainObject = {};
  for (const [key, value] of Object.entries(json)) {
    if (KNOWN_SETTINGS_KEYS.has(key)) {
      view[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) {
    view.extra = extra;
  }
  return view as NekSettingsView;
}

/** 原始 JSON 的差异补丁转成契约补丁：未知键收进 `extra`。 */
export function rawDiffToSettingsPatch(diff: PlainObject): NekSettingsPatch {
  const patch: PlainObject = {};
  const extra: PlainObject = {};
  for (const [key, value] of Object.entries(diff)) {
    if (KNOWN_SETTINGS_KEYS.has(key)) {
      patch[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) {
    patch.extra = extra;
  }
  return patch as NekSettingsPatch;
}
