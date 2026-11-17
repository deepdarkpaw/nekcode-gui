/**
 * models.json 的 `reasoning` + `thinkingLevelMap`：
 * - 基础档位缺省支持；xhigh/max 必须显式映射才支持；
 * - map 值为 null 表示不支持；字符串为上游原始取值（高级）。
 */
import type { NekModelConfig, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS, nekThinkingLevelsFromMap } from "@zcode/shared/nek-protocol";

export interface ThinkingDraft {
  reasoning: boolean;
  enabled: ReadonlySet<NekThinkingLevel>;
  /** 等级 → 上游原始取值；空串表示使用默认映射。 */
  raw: Readonly<Partial<Record<NekThinkingLevel, string>>>;
}

export function thinkingDraftFromModel(
  model: Pick<NekModelConfig, "reasoning" | "thinkingLevelMap">,
): ThinkingDraft {
  const map = model.thinkingLevelMap ?? {};
  const enabled = new Set(nekThinkingLevelsFromMap(map));
  const raw: Partial<Record<NekThinkingLevel, string>> = {};
  for (const level of NEK_THINKING_LEVELS) {
    const value = map[level];
    if (typeof value === "string") {
      raw[level] = value;
    }
  }
  return { reasoning: model.reasoning === true, enabled, raw };
}

/** 编辑态 → 配置；启用的 xhigh/max 即使原始值留空也必须写入显式映射。 */
export function thinkingFieldsFromDraft(
  draft: ThinkingDraft,
): Pick<NekModelConfig, "reasoning" | "thinkingLevelMap"> {
  if (!draft.reasoning) {
    return { reasoning: false, thinkingLevelMap: undefined };
  }
  const map: Partial<Record<NekThinkingLevel, string | null>> = {};
  for (const level of NEK_THINKING_LEVELS) {
    if (!draft.enabled.has(level)) {
      map[level] = null;
      continue;
    }
    const raw = draft.raw[level]?.trim();
    if (raw) {
      map[level] = raw;
    } else if (level === "xhigh" || level === "max") {
      map[level] = level;
    }
  }
  return {
    reasoning: true,
    thinkingLevelMap: map,
  };
}

/** 模型配置里可选的思考等级（用于"默认思考等级"下拉）。 */
export function enabledThinkingLevels(draft: ThinkingDraft): NekThinkingLevel[] {
  if (!draft.reasoning) {
    return ["off"];
  }
  return NEK_THINKING_LEVELS.filter((level) => draft.enabled.has(level));
}
