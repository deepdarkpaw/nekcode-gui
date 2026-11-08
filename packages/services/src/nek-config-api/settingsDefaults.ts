/**
 * settings.json 的默认值与视图编解码。
 *
 * 默认值取自 nek `core/settings-manager.ts`（以及 `compaction/content-policy.ts`、
 * `http-dispatcher.ts`、`core/defaults.ts`）。设置页用它做"恢复默认"与占位显示，
 * 所以必须填全：缺一个默认值，界面就会把"未设置"显示成空白而不是 nek 的真实行为。
 */
import type { NekSettingsView } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";

/** `NekSettingsView` 认识的顶层键；其余键进 `extra` 原样保留。 */
export const SETTINGS_KNOWN_KEYS: readonly string[] = [
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
];

/** nek 的 `DEFAULT_COMPACTION_CONTENT_SETTINGS`。 */
export const COMPACTION_CONTENT_DEFAULTS = {
  thinkingMaxChars: 3000,
  thinkingTotalMaxChars: 24000,
  toolResultMaxChars: 2000,
  toolErrorMaxChars: 6000,
  toolArgumentMaxChars: 2000,
  pruneToolResults: true,
  protectedRecentTokens: 8000,
  protectedToolResults: 6,
} as const;

export const NEK_SETTINGS_DEFAULTS: NekSettingsView = {
  defaultThinkingLevel: "medium",
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    content: { ...COMPACTION_CONTENT_DEFAULTS },
    modelOverrides: {},
  },
  branchSummary: { reserveTokens: 16384, skipPrompt: false },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 },
  webSearch: { provider: "tavily", numResults: 8 },
  httpIdleTimeoutMs: 300_000,
  transport: "auto",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  defaultProjectTrust: "ask",
  hideThinkingBlock: false,
  updateChannel: "stable",
};

/** 文件内容 → 视图：认识的键原样带出，未知键收进 `extra`（保存时原样写回）。 */
export function toSettingsView(raw: Record<string, unknown>): NekSettingsView {
  const view: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SETTINGS_KNOWN_KEYS.includes(key)) view[key] = value;
    else extra[key] = value;
  }
  if (Object.keys(extra).length > 0) view.extra = extra;
  return view as NekSettingsView;
}

/**
 * 补丁 → 可直接送进合并器的普通对象。
 *
 * `extra` 不是真实字段：它是"未知键"的容器，写回时必须摊平成顶层键，
 * 否则 settings.json 里会多出一个 nek 不认识的 `extra` 对象。
 */
export function settingsPatchToRecord(patch: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "extra") {
      if (value === null) continue;
      if (!isPlainObject(value)) {
        throw new Error("settings.extra must be an object");
      }
      Object.assign(record, value);
      continue;
    }
    record[key] = value;
  }
  return record;
}
