import type { Locale, SkillScope } from "@zcode/shared";

/** `$` 技能面板中的来源标签：workspace / user。 */
export function resolveSkillSourceLabel(scope: SkillScope, locale?: Locale): string {
  if (locale === "zh-CN") return scope === "workspace" ? "工作区" : "用户";
  return scope === "workspace" ? "Workspace" : "User";
}
