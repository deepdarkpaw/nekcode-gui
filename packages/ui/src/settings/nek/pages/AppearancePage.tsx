/**
 * 外观与输入（GUI 自身设置，不显示配置目标）：主题、界面字号、代码字号、语言、发送键、
 * thinking 默认折叠、工具输出默认展开、Mermaid、系统通知（回合完成 / 需要输入 / 出错）。
 */
import type { LocalePreference } from "@zcode/shared";
import {
  SettingSection,
  SettingSelectField,
  SettingSwitchField,
} from "@/components/ui/setting-fields.js";
import { SettingNumberField } from "@/components/ui/setting-text-field.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { Theme } from "@/useTheme.js";
import {
  useNekGuiPreferences,
  type NekGuiPreferences,
  type SendKey,
} from "../gui/guiPreferences.js";
import { NekPageFrame } from "../components/NekPageFrame.js";

const DEFAULT_UI_FONT_SIZE_PX = 14;
const THEMES = ["system", "zai-light", "zai-dark"] as const;
type ThemeChoice = (typeof THEMES)[number];

function themeChoice(theme: Theme): ThemeChoice {
  if (theme === "light") return "zai-light";
  if (theme === "dark") return "zai-dark";
  return theme as ThemeChoice;
}

export function AppearancePage() {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const codePreview = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreview = useZCodeStore((state) => state.setCodePreviewSettings);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const preferences = useNekGuiPreferences((state) => state.preferences);
  const update = useNekGuiPreferences((state) => state.update);
  const set = async (patch: Partial<NekGuiPreferences>) => update(patch);
  const setNotify = async (key: keyof NekGuiPreferences["notify"], value: boolean) =>
    update({ notify: { ...preferences.notify, [key]: value } });

  return (
    <NekPageFrame usesTarget={false} description={t("settings.nek.appearance.pageDescription")}>
      <div className="flex flex-col gap-8">
        <SettingSection title={t("settings.nek.appearance.display")}>
          <SettingSelectField<ThemeChoice>
            label={t("settings.nek.appearance.theme")}
            value={themeChoice(theme)}
            options={THEMES.map((value) => ({
              value,
              label: t(`settings.nek.appearance.theme.${value}`),
            }))}
            onCommit={async (value) => setTheme(value)}
          />
          <SettingNumberField
            label={t("settings.nek.appearance.uiFontSize")}
            unit="px"
            integer
            min={MIN_UI_FONT_SIZE_PX}
            max={MAX_UI_FONT_SIZE_PX}
            value={uiFontSizePx}
            defaultValue={DEFAULT_UI_FONT_SIZE_PX}
            onCommit={async (value) => setUiFontSizePx(value)}
          />
          <SettingNumberField
            label={t("settings.nek.appearance.codeFontSize")}
            unit="px"
            integer
            min={12}
            max={20}
            value={codePreview.fontSizePx}
            defaultValue={DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx}
            onCommit={async (fontSizePx) => setCodePreview({ fontSizePx })}
          />
          <SettingSelectField<LocalePreference>
            label={t("settings.nek.appearance.language")}
            value={localePreference}
            options={[
              { value: "system", label: t("settings.nek.appearance.language.system") },
              { value: "zh-CN", label: "中文" },
              { value: "en-US", label: "English" },
            ]}
            onCommit={async (value) => setLocalePreference(value)}
          />
        </SettingSection>
        <SettingSection title={t("settings.nek.appearance.input")}>
          <SettingSelectField<SendKey>
            label={t("settings.nek.appearance.sendKey")}
            description={t("settings.nek.appearance.sendKeyHint")}
            value={preferences.sendKey}
            options={[
              { value: "enter", label: t("settings.nek.appearance.sendKey.enter") },
              { value: "ctrlEnter", label: t("settings.nek.appearance.sendKey.ctrlEnter") },
            ]}
            onCommit={(sendKey) => set({ sendKey })}
          />
        </SettingSection>
        <SettingSection title={t("settings.nek.appearance.conversation")}>
          <SettingSwitchField
            label={t("settings.nek.appearance.thinkingCollapsed")}
            description={t("settings.nek.appearance.thinkingCollapsedHint")}
            value={preferences.thinkingCollapsed}
            onCommit={(thinkingCollapsed) => set({ thinkingCollapsed })}
          />
          <SettingSwitchField
            label={t("settings.nek.appearance.toolOutputExpanded")}
            description={t("settings.nek.appearance.toolOutputExpandedHint")}
            value={preferences.toolOutputExpanded}
            onCommit={(toolOutputExpanded) => set({ toolOutputExpanded })}
          />
          <SettingSwitchField
            label={t("settings.nek.appearance.mermaid")}
            value={preferences.mermaid}
            onCommit={(mermaid) => set({ mermaid })}
          />
        </SettingSection>
        <SettingSection
          title={t("settings.nek.appearance.notifications")}
          description={t("settings.nek.appearance.notificationsHint")}
        >
          <SettingSwitchField
            label={t("settings.nek.appearance.notifyEnabled")}
            value={notificationEnabled}
            onCommit={async (enabled) => setNotificationEnabled(enabled)}
          />
          {(["turnComplete", "needsInput", "error"] as const).map((key) => (
            <SettingSwitchField
              key={key}
              label={t(`settings.nek.appearance.notify.${key}`)}
              value={preferences.notify[key]}
              disabled={!notificationEnabled}
              onCommit={(value) => setNotify(key, value)}
            />
          ))}
        </SettingSection>
      </div>
    </NekPageFrame>
  );
}
