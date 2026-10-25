/**
 * 设置中心分区 id（纯数据，供 lib/settingsNavigation 使用，不引入图标等界面依赖）。
 */
export const NEK_SETTINGS_SECTION_IDS = [
  "nekAccounts",
  "nekProviders",
  "nekDefaultModel",
  "nekCompaction",
  "nekTools",
  "nekMcp",
  "nekAgent",
  "nekProject",
  "nekRemoteHosts",
  "nekAppearance",
  "nekShortcuts",
  "nekAdvanced",
  "nekAbout",
] as const;

export type NekSettingsSectionId = (typeof NEK_SETTINGS_SECTION_IDS)[number];

export function isNekSettingsSectionId(value: string): value is NekSettingsSectionId {
  return (NEK_SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}
