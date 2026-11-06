import { useEffect, useState } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";

export type SubagentConversation = Awaited<
  ReturnType<IZCodeAgentService["getSubagentConversation"]>
>;

/** 只维护可见侧栏的一份投影；单航班刷新，切换/关闭后迟到结果不能写入新视图。 */
export function useSubagentConversation(
  load: () => Promise<SubagentConversation>,
  active: boolean,
) {
  const [state, setState] = useState<{
    source: typeof load;
    data?: SubagentConversation;
    error?: string;
  }>({ source: load });
  const [retryEpoch, setRetryEpoch] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) => ({
      source: load,
      ...(previous.source === load ? { data: previous.data } : {}),
    }));
    const refresh = async () => {
      try {
        const data = await load();
        if (cancelled) return;
        setState({ source: load, data });
        if (data.status === "running")
          timer = setTimeout(() => void refresh(), NEK_STATUS_TRANSCRIPT_REFRESH_MS);
      } catch (error) {
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, load, retryEpoch]);
  return {
    data: state.source === load ? state.data : undefined,
    error: state.source === load ? state.error : undefined,
    retry: () => setRetryEpoch((epoch) => epoch + 1),
  };
}
