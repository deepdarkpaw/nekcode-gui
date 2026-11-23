/**
 * 目标机器上各配置文件的位置。
 *
 * 与 nek 一致：全局配置在 agent 目录（`~/.nek/agent`），项目配置在 `<cwd>/.nek`，
 * 项目的指令文件在工作目录本身。
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

/** Instruction files are looked up in agentDir/cwd, not in the project's `.nek` directory. */
export function instructionsDir(
  layout: NekConfigLayout,
  scope: NekConfigScope,
  cwd?: string,
): string {
  const paths = targetPaths(layout.agentDir);
  const dir = scope === "global" ? layout.agentDir : requireCwd(scope, cwd);
  if (!paths.isAbsolute(dir))
    throw validationError(`Instructions require an absolute directory: ${dir}`);
  return paths.normalize(dir);
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
