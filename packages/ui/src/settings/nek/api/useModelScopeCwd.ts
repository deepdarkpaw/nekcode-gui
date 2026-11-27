import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { sameTarget, useNekSettingsContext } from "./NekSettingsContext.js";

/** 不能把活动工作区的路径拿到另一台机器上读写项目范围。 */
export function useModelScopeCwd(destination?: NekConfigTarget): string | undefined {
  const { projectCwd, projectEnvironmentKey, projectTarget, target, targets } =
    useNekSettingsContext();
  const effectiveTarget = destination ?? target;
  if (projectTarget) return sameTarget(projectTarget, effectiveTarget) ? projectCwd : undefined;
  if (effectiveTarget.kind === "local") {
    return projectEnvironmentKey === undefined ? projectCwd : undefined;
  }
  const info = targets.list.find((entry) => sameTarget(entry.target, effectiveTarget));
  return projectEnvironmentKey && info?.remoteEnvironmentKey === projectEnvironmentKey
    ? projectCwd
    : undefined;
}
