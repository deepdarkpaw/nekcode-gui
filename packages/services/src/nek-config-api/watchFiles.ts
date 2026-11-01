/**
 * 监视目录的候选配置文件名。
 *
 * 与 `paths.ts` 保持一致：目录里除了下面这些名字，其余文件（会话、日志、缓存）不触发通知，
 * 否则 agent 目录的噪声会让设置页不断重载。
 */
import { join } from "node:path";

export const CONFIG_FILE_NAMES: readonly string[] = [
  "models.json",
  "auth.json",
  "settings.json",
  "mcp.json",
  "nek.yaml",
  "AGENTS.md",
];

export function baselineConfigFiles(dir: string): string[] {
  return CONFIG_FILE_NAMES.map((name) => join(dir, name));
}
