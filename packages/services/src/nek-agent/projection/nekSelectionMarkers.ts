import type { NekSessionEntry } from "@zcode/shared/nek-protocol";
import { buildModelChangeMarker } from "./nekRows.js";

interface SelectionCursor {
  provider?: string;
  model?: string;
  thought?: string;
}

type SelectionEntry = Extract<NekSessionEntry, { type: "model_change" | "thinking_level_change" }>;

/**
 * 历史和实时共用的选择转换：初始化不是 X→X，重复事实不产生新行。
 * 历史游标必须从空开始，不能用最终 get_state 倒推过去的 from；初始思考等级只建立基线。
 */
export function projectSelectionEntry(previous: SelectionCursor, entry: SelectionEntry) {
  const next: SelectionCursor =
    entry.type === "model_change"
      ? { ...previous, provider: entry.provider, model: entry.modelId }
      : { ...previous, thought: entry.thinkingLevel };
  const changed =
    entry.type === "model_change"
      ? previous.provider !== next.provider || previous.model !== next.model
      : Boolean(previous.thought) && previous.thought !== next.thought;
  if (!next.provider || !next.model || !changed) return { next, marker: undefined };
  return {
    next,
    marker: buildModelChangeMarker({
      ...(previous.provider && previous.model
        ? { from: { provider: previous.provider, model: previous.model } }
        : {}),
      to: { provider: next.provider, model: next.model },
      toThought: next.thought ?? "",
    }),
  };
}
