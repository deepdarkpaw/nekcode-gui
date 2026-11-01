/* eslint-disable max-lines -- 设置导航意图集中管理 sessionStorage、事件桥接和解析校验，拆分会让一次性意图消费顺序更难保证。 */
import { logger } from "@/logger.js";
import { isNekSettingsSectionId, type NekSettingsSectionId } from "@/settings/nek/sectionIds.js";

export type SettingsSectionId =
  | "general"
  | "migration"
  | "memory"
  | "skill"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | NekSettingsSectionId;

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // 工作区搜索（.zcodiumignore）设置入口先隐藏：规则文件仍生效并可手动编辑，
  // 编辑页代码保留，放开时从这里移除即可。
  "workspaceFileSearch",
]);

/** 旧入口 → nek 设置中心对应页面（保留历史偏好与已有跳转调用）。 */
const LEGACY_SECTION_REDIRECTS = {
  modelProvider: "nekProviders",
  mcp: "nekMcp",
  appearance: "nekAppearance",
  shortcuts: "nekShortcuts",
  subagents: "nekAgent",
} as const satisfies Record<string, NekSettingsSectionId>;

type SettingsSectionInput = SettingsSectionId | keyof typeof LEGACY_SECTION_REDIRECTS;

interface SettingsSectionIntentEventDetail {
  section: SettingsSectionInput;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "migration" ||
    value === "memory" ||
    value === "skill" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    isNekSettingsSectionId(value)
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

function isLegacySettingsSection(value: string): value is keyof typeof LEGACY_SECTION_REDIRECTS {
  return Object.hasOwn(LEGACY_SECTION_REDIRECTS, value);
}

function isSettingsSectionInput(value: string): value is SettingsSectionInput {
  return isSettingsSectionId(value) || isLegacySettingsSection(value);
}

export function resolveSettingsSection(
  section: SettingsSectionInput,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (isLegacySettingsSection(section)) return LEGACY_SECTION_REDIRECTS[section];
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // 部分 WebView / 移动远控容器可能禁用 localStorage。
    // 设置页分区记忆只是 UI 偏好，存储不可用时回退默认入口，不应阻断打开设置页。
    logger.warn("[settingsNavigation] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // 旧版“代码预览”已并入“外观”，保留用户上次停留位置的迁移语义。
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "nekAppearance");
      return "nekAppearance";
    }
    if (raw && isSettingsSectionInput(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] 读取上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionInput): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] 写入上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // 普通打开设置页以前把 consumePendingSettingsSection 的 fallback 写死为
  // modelProvider，导致没有显式跳转意图时也总进“模型供应商”。这里先读上次停留分区，
  // 再让 quickpick / 管理模型这类一次性意图覆盖它，保留显式入口的直达语义。
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionInput): void {
  setPendingSettingsSectionIntent(section);
}

export function setPendingSettingsSectionIntent(section: SettingsSectionInput): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  // 设置页已经打开时不会重新挂载，单纯写 sessionStorage 没有订阅者会响应。
  // 同窗口补发自定义事件，让已打开的 SettingsPage 也能即时跳到 quickpick 指定分区。
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // 旧 Skills 使用复数 id；迁移到当前独立 skill 分区。
      return "skill";
    }
    if (raw && isSettingsSectionInput(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  return fallbackSection;
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionInput(detail.section)) {
      // 设置页已打开时，事件已经承载了这次跳转意图。
      // 这里同步清掉 sessionStorage，避免用户随后切到别的分区并退出后，
      // 下次挂载又被陈旧 pending 意图覆盖“上次停留分区”。
      clearPendingSettingsSectionIntent();
      listener(resolveSettingsSection(detail.section));
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}
