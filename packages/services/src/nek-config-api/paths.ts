/**
 * 目标机器上各配置文件的位置。
 *
 * 与 nek 一致：全局配置在 agent 目录（`~/.nek/agent`），项目配置在 `<cwd>/.nek`，
 * 只有 `AGENTS.md` 在项目根目录。
 */
import { join, posix, win32 } from "node:path";
import { isAgentPresetFileName, type NekConfigScope } from "@zcode/shared/nek-protocol";
import { validationError } from "./errors.js";

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

/** Match the target's paths even when the settings host and nek run on different OSes. */
export function targetPaths(anchor: string) {
  return /^[A-Za-z]:|^\\/u.test(anchor) ? win32 : posix;
}

export function agentsDir(layout: NekConfigLayout, scope: NekConfigScope, cwd?: string): string {
  const paths = targetPaths(layout.agentDir);
  return scope === "global"
    ? paths.join(layout.agentDir, "agents")
    : paths.join(requireCwd(scope, cwd), PROJECT_CONFIG_DIR_NAME, "agents");
}

/** Only create/rename operations derive a path from the preset's logical name. */
export function newAgentPresetPath(dir: string, name: string): string {
  if (!isAgentPresetFileName(name)) {
    throw validationError(`invalid preset filename: ${name}`, { name: "invalid filename" });
  }
  return targetPaths(dir).join(dir, `${name}.md`);
}

/** Accept only lexical direct children of the selected agents directory. */
export function agentPresetFileName(dir: string, file: string): string {
  const paths = targetPaths(dir);
  const filename = paths.basename(file);
  if (!filename.endsWith(".md") || file.includes("\0") || file !== paths.join(dir, filename)) {
    throw validationError(`invalid preset path: ${file}`);
  }
  return filename;
}

function requireCwd(scope: NekConfigScope, cwd?: string): string {
  if (scope === "project" && (!cwd || cwd.trim() === "")) {
    throw new Error("project scope requires cwd");
  }
  return cwd ?? "";
}
