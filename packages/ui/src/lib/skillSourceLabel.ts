import type { Locale, ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";

/** `/` 技能候选的来源标签：workspace / user。 */
export function resolveSkillSourceLabel(
  scope: ZCodeSkillReferenceCatalogEntry["scope"],
  locale?: Locale,
): string {
  if (locale === "zh-CN") return scope === "workspace" ? "工作区" : "用户";
  return scope === "workspace" ? "Workspace" : "User";
}
