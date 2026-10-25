/**
 * 设置中心分区定义（计划 §6 的 13 页）。`usesTarget`：页面涉及 nek 配置，显示"配置目标"切换。
 */
import {
  BotIcon,
  BoxesIcon,
  CableIcon,
  CircleUserRoundIcon,
  FolderGit2Icon,
  InfoIcon,
  KeyboardIcon,
  type LucideIcon,
  PaletteIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  ShrinkIcon,
  WrenchIcon,
} from "lucide-react";

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

export type NekSettingsGroupId = "nekConfig" | "nekApp";

export interface NekSettingsSectionDefinition {
  id: NekSettingsSectionId;
  icon: LucideIcon;
  titleId: string;
  groupId: NekSettingsGroupId;
  usesTarget: boolean;
}

export const NEK_SETTINGS_GROUPS: ReadonlyArray<{ id: NekSettingsGroupId; titleId: string }> = [
  { id: "nekConfig", titleId: "settings.nek.group.config" },
  { id: "nekApp", titleId: "settings.nek.group.app" },
];

export const NEK_SETTINGS_SECTIONS: readonly NekSettingsSectionDefinition[] = [
  {
    id: "nekAccounts",
    icon: CircleUserRoundIcon,
    titleId: "settings.nek.section.accounts",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekProviders",
    icon: BoxesIcon,
    titleId: "settings.nek.section.providers",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekDefaultModel",
    icon: SparklesIcon,
    titleId: "settings.nek.section.defaultModel",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekCompaction",
    icon: ShrinkIcon,
    titleId: "settings.nek.section.compaction",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekTools",
    icon: WrenchIcon,
    titleId: "settings.nek.section.tools",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekMcp",
    icon: CableIcon,
    titleId: "settings.nek.section.mcp",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekAgent",
    icon: BotIcon,
    titleId: "settings.nek.section.agent",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekProject",
    icon: FolderGit2Icon,
    titleId: "settings.nek.section.project",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekAdvanced",
    icon: SlidersHorizontalIcon,
    titleId: "settings.nek.section.advanced",
    groupId: "nekConfig",
    usesTarget: true,
  },
  {
    id: "nekRemoteHosts",
    icon: ServerIcon,
    titleId: "settings.nek.section.remoteHosts",
    groupId: "nekApp",
    usesTarget: false,
  },
  {
    id: "nekAppearance",
    icon: PaletteIcon,
    titleId: "settings.nek.section.appearance",
    groupId: "nekApp",
    usesTarget: false,
  },
  {
    id: "nekShortcuts",
    icon: KeyboardIcon,
    titleId: "settings.nek.section.shortcuts",
    groupId: "nekApp",
    usesTarget: false,
  },
  {
    id: "nekAbout",
    icon: InfoIcon,
    titleId: "settings.nek.section.about",
    groupId: "nekApp",
    usesTarget: true,
  },
];

export function isNekSettingsSectionId(value: string): value is NekSettingsSectionId {
  return (NEK_SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export function getNekSettingsSection(id: NekSettingsSectionId): NekSettingsSectionDefinition {
  const section = NEK_SETTINGS_SECTIONS.find((item) => item.id === id);
  if (!section) {
    throw new Error(`Unknown nek settings section ${id}`);
  }
  return section;
}
