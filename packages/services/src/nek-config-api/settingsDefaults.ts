/**
 * settings.json 的默认值与视图编解码。
 *
 * 默认值取自 nek v0.5.1 `core/settings-manager.ts`（以及 `compaction/content-policy.ts`、
 * `http-dispatcher.ts`、`core/defaults.ts`）。设置页用它做"恢复默认"与占位显示，
 * 所以必须填全：缺一个默认值，界面就会把"未设置"显示成空白而不是 nek 的真实行为。
 */
import {
  NEK_SETTINGS_KNOWN_KEYS,
  parseNekTimeoutMs,
  type NekSettingsView,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { mergeDeep } from "./documents.js";
import { validationError } from "./errors.js";

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
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
    provider: { maxRetryDelayMs: 60000 },
  },
  webSearch: { provider: "tavily", numResults: 8 },
  httpIdleTimeoutMs: 300_000,
  transport: "auto",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  defaultProjectTrust: "ask",
  hideThinkingBlock: false,
  updateChannel: "stable",
};

/** Apply the nek v0.5.1 settings-manager.ts load migrations per scope, without touching disk. */
export function loadNekSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...raw };
  if ("queueMode" in raw && !("steeringMode" in raw)) {
    settings.steeringMode = raw.queueMode;
    delete settings.queueMode;
  }
  if (!("transport" in raw) && typeof raw.websockets === "boolean") {
    settings.transport = raw.websockets ? "websocket" : "sse";
    delete settings.websockets;
  }
  if (isPlainObject(raw.skills)) {
    if (raw.skills.enableSkillCommands !== undefined && raw.enableSkillCommands === undefined) {
      settings.enableSkillCommands = raw.skills.enableSkillCommands;
    }
    const directories = raw.skills.customDirectories;
    if (Array.isArray(directories) && directories.length > 0) settings.skills = directories;
    else delete settings.skills;
  }
  if (isPlainObject(raw.retry)) {
    const { maxDelayMs, ...retry } = raw.retry;
    const provider = retry.provider;
    const providerSettings =
      typeof provider === "object" && provider !== null ? provider : undefined;
    if (
      typeof maxDelayMs === "number" &&
      (!isPlainObject(providerSettings) || providerSettings.maxRetryDelayMs == null)
    ) {
      retry.provider = { ...providerSettings, maxRetryDelayMs: maxDelayMs };
    }
    settings.retry = retry;
  }
  return settings;
}

/** Effective projections preserve invalid values for diagnostics, but apply core defaults/normalization to valid values. */
export function toEffectiveSettingsView(explicit: Record<string, unknown>): NekSettingsView {
  const merged = mergeDeep(NEK_SETTINGS_DEFAULTS as Record<string, unknown>, explicit);
  const defaults = NEK_SETTINGS_DEFAULTS;
  merged.httpIdleTimeoutMs =
    explicit.httpIdleTimeoutMs === undefined
      ? defaults.httpIdleTimeoutMs
      : (parseNekTimeoutMs(explicit.httpIdleTimeoutMs) ?? explicit.httpIdleTimeoutMs);
  merged.transport = explicit.transport ?? defaults.transport;
  merged.steeringMode = explicit.steeringMode || defaults.steeringMode;
  merged.followUpMode = explicit.followUpMode || defaults.followUpMode;
  const retry = isPlainObject(explicit.retry) ? explicit.retry : {};
  const provider = isPlainObject(retry.provider) ? retry.provider : {};
  merged.retry = {
    ...retry,
    enabled: retry.enabled ?? defaults.retry?.enabled,
    maxRetries: retry.maxRetries ?? defaults.retry?.maxRetries,
    baseDelayMs: retry.baseDelayMs ?? defaults.retry?.baseDelayMs,
    maxAgentDelayMs: retry.maxAgentDelayMs ?? defaults.retry?.maxAgentDelayMs,
    provider: {
      ...provider,
      maxRetryDelayMs: provider.maxRetryDelayMs ?? defaults.retry?.provider?.maxRetryDelayMs,
    },
  };
  return toSettingsView(merged);
}

/** 文件内容 → 视图：认识的键原样带出，未知键收进 `extra`（保存时原样写回）。 */
export function toSettingsView(raw: Record<string, unknown>): NekSettingsView {
  const view: Array<[string, unknown]> = [];
  const extra: Array<[string, unknown]> = [];
  for (const entry of Object.entries(raw)) {
    (NEK_SETTINGS_KNOWN_KEYS.has(entry[0]) ? view : extra).push(entry);
  }
  if (extra.length > 0) view.push(["extra", Object.fromEntries(extra)]);
  return Object.fromEntries(view) as NekSettingsView;
}

/**
 * 补丁 → 可直接送进合并器的普通对象。
 *
 * `extra` 不是真实字段：它是"未知键"的容器，写回时必须摊平成顶层键，
 * 否则 settings.json 里会多出一个 nek 不认识的 `extra` 对象。
 */
export function settingsPatchToRecord(patch: Record<string, unknown>): Record<string, unknown> {
  const record = new Map<string, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "extra") {
      record.set(key, value);
      continue;
    }
    if (value == null) continue;
    if (!isPlainObject(value))
      throw validationError("settings.extra must be an object", { extra: "expected an object" });
    for (const [extraKey, extraValue] of Object.entries(value)) record.set(extraKey, extraValue);
  }
  return Object.fromEntries(record);
}
