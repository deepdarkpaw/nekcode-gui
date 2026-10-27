/**
 * 只读查询（可用模型、登录状态、资源清单、信任状态、MCP 运行状态……）：
 * 目标变化或任意写入 / 外部修改后自动刷新；刷新期间保留旧数据，避免闪烁。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { INekConfigApi, NekConfigTarget } from "@zcode/shared/nek-protocol";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { toNekConfigApiError, type NekConfigApiError } from "./nekErrors.js";

export interface NekQuery<T> {
  status: "disconnected" | "loading" | "ready" | "error";
  data: T | undefined;
  error: NekConfigApiError | undefined;
  reload: () => Promise<void>;
}

export function useNekQuery<T>(
  fetcher: (api: INekConfigApi, target: NekConfigTarget) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; refreshOnWrite?: boolean } = {},
): NekQuery<T> {
  const { config, target, targetKey, targetInfo, writeVersion } = useNekSettingsContext();
  const enabled = (options.enabled ?? true) && targetInfo?.connected === true;
  const refreshVersion = options.refreshOnWrite === false ? 0 : writeVersion;
  const [state, setState] = useState<Omit<NekQuery<T>, "reload">>({
    status: enabled ? "loading" : "disconnected",
    data: undefined,
    error: undefined,
  });
  const latestRef = useRef({ fetcher, config, target });
  latestRef.current = { fetcher, config, target };
  const generationRef = useRef(0);

  const run = useCallback(async () => {
    const generation = ++generationRef.current;
    const { fetcher: current, config: api, target: currentTarget } = latestRef.current;
    try {
      const data = await current(api, currentTarget);
      if (generation === generationRef.current) {
        setState({ status: "ready", data, error: undefined });
      }
    } catch (error) {
      if (generation === generationRef.current) {
        setState((previous) => ({
          status: "error",
          data: previous.data,
          error: toNekConfigApiError(error),
        }));
      }
    }
  }, []);

  const depsKey = JSON.stringify(deps);
  const scopeKey = `${targetKey}|${depsKey}`;
  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      setState({ status: "disconnected", data: undefined, error: undefined });
      return;
    }
    // 目标或参数变化：清空旧数据；仅因写入而刷新：保留旧数据。
    const scopeChanged = scopeRef.current !== scopeKey;
    scopeRef.current = scopeKey;
    setState((previous) =>
      scopeChanged || previous.data === undefined
        ? { status: "loading", data: undefined, error: undefined }
        : previous,
    );
    void run();
  }, [enabled, scopeKey, refreshVersion, run]);

  return { ...state, reload: run };
}
