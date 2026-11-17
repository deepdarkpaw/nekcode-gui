import { NEK_THINKING_LEVELS, type NekCatalogModel, type NekThinkingLevel } from "./gui-rpc.js";

/**
 * 解码思考模型的配置映射，与 nek `getSupportedThinkingLevels` 一致：
 * 基础档位缺省支持，xhigh/max 必须显式映射，null 始终禁用。
 * 调用方负责 reasoning 开关；运行态能力仍以 nek 的模型目录为准。
 */
export function nekThinkingLevelsFromMap(
  map: NekCatalogModel["thinkingLevelMap"],
): NekThinkingLevel[] {
  return NEK_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
