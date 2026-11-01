// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPendingSettingsSectionListener,
  consumeInitialSettingsSection,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  writeLastSettingsSectionPreference,
} from "./settingsNavigation.js";
import { createSettingsPageConfig } from "../settings/settingsPageConfig.js";
import { NEK_SETTINGS_SECTION_IDS } from "../settings/nek/sectionIds.js";

const LAST_SECTION_KEY = "zcode-settings-last-section";
const INTENT_KEY = "zcode-settings-section-intent";
const REDIRECTS = [
  ["modelProvider", "nekProviders"],
  ["mcp", "nekMcp"],
  ["appearance", "nekAppearance"],
  ["shortcuts", "nekShortcuts"],
  ["subagents", "nekAgent"],
] as const;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("retired settings section redirects", () => {
  it.each(REDIRECTS)("redirects persisted %s to %s", (legacy, destination) => {
    window.localStorage.setItem(LAST_SECTION_KEY, legacy);
    expect(consumeInitialSettingsSection()).toBe(destination);
    writeLastSettingsSectionPreference(legacy);
    expect(window.localStorage.getItem(LAST_SECTION_KEY)).toBe(destination);
  });

  it.each(REDIRECTS)("redirects pending %s to %s", (legacy, destination) => {
    setPendingSettingsSectionIntent(legacy);
    expect(consumeInitialSettingsSection()).toBe(destination);
    expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it.each(REDIRECTS)("redirects an already-open %s intent to %s", (legacy, destination) => {
    const listener = vi.fn();
    const dispose = addPendingSettingsSectionListener(listener);
    try {
      setPendingSettingsSectionIntent(legacy);
      expect(listener).toHaveBeenCalledExactlyOnceWith(destination);
      expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
    } finally {
      dispose();
    }
    setPendingSettingsSectionIntent(legacy);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("migrates the older code preview preference directly to nek appearance", () => {
    window.localStorage.setItem(LAST_SECTION_KEY, "codePreview");
    expect(consumeInitialSettingsSection()).toBe("nekAppearance");
    expect(window.localStorage.getItem(LAST_SECTION_KEY)).toBe("nekAppearance");
  });

  it("keeps explicit intents ahead of the last section preference", () => {
    window.localStorage.setItem(LAST_SECTION_KEY, "shortcuts");
    setPendingSettingsSectionIntent("mcp");
    expect(consumeInitialSettingsSection()).toBe("nekMcp");
    expect(consumeInitialSettingsSection()).toBe("nekShortcuts");
  });

  it("keeps workspace file search hidden and preserves the active sections", () => {
    const { settingsSections } = createSettingsPageConfig();
    expect(settingsSections.map((section) => section.id).toSorted()).toEqual(
      [...NEK_SETTINGS_SECTION_IDS, "general", "memory", "skill", "commands", "hooks"].toSorted(),
    );
    expect(NEK_SETTINGS_SECTION_IDS).toHaveLength(13);
    expect(resolveSettingsSection("workspaceFileSearch", "nekMcp")).toBe("nekMcp");
  });
});
