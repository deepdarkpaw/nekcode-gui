/**
 * 读取 nekcode-gui 运行参数。
 *
 * 优先级：用户覆盖 `~/.nek/gui/config.yaml` > 随包 `config/config.yaml` > 内置默认值。
 * 两个文件都按键合并（用户文件只需写想改的键）；任何解析错误都进诊断，不中断启动。
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  type GuiRuntimeConfig,
  type GuiRuntimeConfigDiagnostic,
  parseGuiRuntimeConfig,
} from "@zcode/shared/guiRuntimeConfig";

export interface GuiRuntimeConfigSource {
  /** 文件路径；文件不存在时跳过，不报错。 */
  path: string;
  /** 来源标签，用于诊断（例如 `bundled` / `user`）。 */
  label: string;
}

export interface LoadedGuiRuntimeConfig {
  config: GuiRuntimeConfig;
  /** 每条诊断的 `path` 前缀为来源标签，例如 `user:nek.idleMinutes`。 */
  diagnostics: GuiRuntimeConfigDiagnostic[];
  /** 实际读到的文件（按优先级从低到高）。 */
  loadedFrom: string[];
}

type ReadText = (path: string) => Promise<string | undefined>;

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 两层文档按分节浅合并：后者的分节键覆盖前者。 */
function mergeDocuments(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [section, value] of Object.entries(override)) {
    const previous = merged[section];
    merged[section] = isRecord(previous) && isRecord(value) ? { ...previous, ...value } : value;
  }
  return merged;
}

/** 按 `sources` 顺序（优先级从低到高）读取并合并。 */
export async function loadGuiRuntimeConfig(
  sources: readonly GuiRuntimeConfigSource[],
  readText: ReadText = readTextIfExists,
): Promise<LoadedGuiRuntimeConfig> {
  const diagnostics: GuiRuntimeConfigDiagnostic[] = [];
  const loadedFrom: string[] = [];
  let document: Record<string, unknown> = {};
  for (const source of sources) {
    let text: string | undefined;
    try {
      text = await readText(source.path);
    } catch (error) {
      diagnostics.push({
        path: `${source.label}:`,
        message: `cannot read ${source.path}: ${String(error)}`,
      });
      continue;
    }
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (error) {
      diagnostics.push({
        path: `${source.label}:`,
        message: `invalid YAML in ${source.path}: ${String(error)}`,
      });
      continue;
    }
    loadedFrom.push(source.path);
    if (parsed === null || parsed === undefined) continue;
    if (!isRecord(parsed)) {
      diagnostics.push({
        path: `${source.label}:`,
        message: `config root must be a mapping in ${source.path}`,
      });
      continue;
    }
    // 先单独校验这一层，诊断带上来源；再参与合并
    for (const diagnostic of parseGuiRuntimeConfig(parsed).diagnostics) {
      diagnostics.push({ path: `${source.label}:${diagnostic.path}`, message: diagnostic.message });
    }
    document = mergeDocuments(document, parsed);
  }
  return { config: parseGuiRuntimeConfig(document).config, diagnostics, loadedFrom };
}
