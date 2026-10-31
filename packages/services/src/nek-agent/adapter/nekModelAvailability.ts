/**
 * nek 侧“有没有可用模型”的事实读取。
 *
 * 只读 `<agentDir>/models.json` 与 `<agentDir>/settings.json`：这两个文件是 nek 与其设置页
 * 的唯一事实来源。这里不读 API Key、不解析 overrides，只统计可用的服务商/模型数量与默认选择。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import type { ZCodeModelProviderAvailability } from "../../zcode-agent/zcodeAgent.js";

interface ModelsFileProvider {
  models?: unknown;
}

interface ModelsFile {
  providers?: Record<string, ModelsFileProvider>;
}

interface SettingsFile {
  defaultProvider?: unknown;
  defaultModel?: unknown;
}

/** models.json 允许注释与尾逗号（nek 自己也是这么读的）。 */
function parseJsonc(text: string): unknown {
  return parse(text, [], { allowTrailingComma: true, disallowComments: false });
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function countModels(provider: ModelsFileProvider): number {
  return Array.isArray(provider.models) ? provider.models.length : 0;
}

/**
 * 组装读取器：优先用注入实现（生产按定位到的 agentDir 注入）；否则退回显式 agentDir。
 * 两者都没有时抛错，而不是把“不知道”伪装成“没有模型”。
 */
export function createNekModelAvailabilityReader(
  injected: (() => Promise<ZCodeModelProviderAvailability>) | undefined,
  agentDir: string | undefined,
): () => Promise<ZCodeModelProviderAvailability> {
  if (injected) return injected;
  if (!agentDir) {
    return async () => {
      throw new Error("nek agentDir is unknown; cannot read model availability");
    };
  }
  return async () => await readNekModelAvailability(agentDir);
}

/**
 * 读取可用模型事实。文件缺失或格式错误时返回 `available: false`：
 * 这不是“降级”，而是 nek 自己在这种情况下也确实无法开始回合。
 */
export async function readNekModelAvailability(
  agentDir: string,
): Promise<ZCodeModelProviderAvailability> {
  const modelsText = await readText(join(agentDir, "models.json"));
  if (!modelsText) return { available: false, providerCount: 0, modelCount: 0 };
  let models: ModelsFile;
  try {
    models = (parseJsonc(modelsText) ?? {}) as ModelsFile;
  } catch {
    return { available: false, providerCount: 0, modelCount: 0 };
  }
  const entries = Object.entries(models.providers ?? {});
  let providerCount = 0;
  let modelCount = 0;
  for (const [, provider] of entries) {
    const count = countModels(provider);
    if (count === 0) continue;
    providerCount += 1;
    modelCount += count;
  }
  if (providerCount === 0) return { available: false, providerCount: 0, modelCount: 0 };

  const defaultSelection = await readDefaultSelection(agentDir, models);
  return {
    available: true,
    providerCount,
    modelCount,
    ...(defaultSelection ? { defaultSelection } : {}),
  };
}

/** settings.json 的默认选择；缺省时退回第一个带模型的服务商的第一条模型。 */
async function readDefaultSelection(
  agentDir: string,
  models: ModelsFile,
): Promise<{ provider: string; model: string } | undefined> {
  const settingsText = await readText(join(agentDir, "settings.json"));
  if (settingsText) {
    try {
      const settings = (parseJsonc(settingsText) ?? {}) as SettingsFile;
      if (
        typeof settings.defaultProvider === "string" &&
        typeof settings.defaultModel === "string"
      ) {
        return { provider: settings.defaultProvider, model: settings.defaultModel };
      }
    } catch {
      // 坏 settings.json 不影响“有模型”这一事实：下面退回第一条模型。
    }
  }
  for (const [providerId, provider] of Object.entries(models.providers ?? {})) {
    const first = Array.isArray(provider.models) ? provider.models[0] : undefined;
    const modelId =
      typeof first === "string"
        ? first
        : typeof first === "object" && first !== null && "id" in first
          ? (first as { id?: unknown }).id
          : undefined;
    if (typeof modelId === "string") return { provider: providerId, model: modelId };
  }
  return undefined;
}
