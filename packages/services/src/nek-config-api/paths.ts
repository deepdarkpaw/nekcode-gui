/**
 * 目标机器上各配置文件的位置。
 *
 * 与 nek 一致：全局配置在 agent 目录（`~/.nek/agent`），项目配置在 `<cwd>/.nek`，
 * 只有 `AGENTS.md` 在项目根目录。
 */
import { join } from "node:path";
import type { NekConfigScope } from "@zcode/shared/nek-protocol";

export interface NekConfigLayout {
  /** `~/.nek/agent`（可被 `NEK_CODING_AGENT_DIR` 覆盖）。 */
  agentDir: string;
}

export const PROJECT_CONFIG_DIR_NAME = ".nek";

export function projectConfigDir(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_DIR_NAME);
}

export function modelsPath(layout: NekConfigLayout): string {
  return join(layout.agentDir, "models.json");
}

export function settingsPath(layout: NekConfigLayout, scope: NekConfigScope, cwd?: string): string {
  return scope === "global"
    ? join(layout.agentDir, "settings.json")
    : join(projectConfigDir(requireCwd(scope, cwd)), "settings.json");
}

export function mcpPath(layout: NekConfigLayout, scope: NekConfigScope, cwd?: string): string {
  return scope === "global"
    ? join(layout.agentDir, "mcp.json")
    : join(projectConfigDir(requireCwd(scope, cwd)), "mcp.json");
}

export function nekYamlPath(layout: NekConfigLayout, scope: NekConfigScope, cwd?: string): string {
  return scope === "global"
    ? join(layout.agentDir, "nek.yaml")
    : join(projectConfigDir(requireCwd(scope, cwd)), "nek.yaml");
}

/** 指令文件：全局是 `<agentDir>/AGENTS.md`，项目是 `<cwd>/AGENTS.md`。 */
export function instructionsPath(
  layout: NekConfigLayout,
  scope: NekConfigScope,
  cwd?: string,
): string {
  return scope === "global"
    ? join(layout.agentDir, "AGENTS.md")
    : join(requireCwd(scope, cwd), "AGENTS.md");
}

export function agentsDir(layout: NekConfigLayout, scope: NekConfigScope, cwd?: string): string {
  return scope === "global"
    ? join(layout.agentDir, "agents")
    : join(projectConfigDir(requireCwd(scope, cwd)), "agents");
}

export function agentPresetPath(
  layout: NekConfigLayout,
  scope: NekConfigScope,
  name: string,
  cwd?: string,
): string {
  return join(agentsDir(layout, scope, cwd), `${name}.md`);
}

/** 资源目录（skills / prompts / extensions）的全局与项目位置。 */
export function resourceDirs(
  layout: NekConfigLayout,
  kind: "skills" | "prompts" | "extensions",
  cwd?: string,
): string[] {
  const dirs = [join(layout.agentDir, kind)];
  if (cwd) dirs.push(join(projectConfigDir(cwd), kind));
  return dirs;
}

function requireCwd(scope: NekConfigScope, cwd?: string): string {
  if (scope === "project" && (!cwd || cwd.trim() === "")) {
    throw new Error("project scope requires cwd");
  }
  return cwd ?? "";
}
