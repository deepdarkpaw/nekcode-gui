import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  /** 重新读取（读取失败、配置刚修好、用户点重试时使用）。 */
  reload(): void;
}

interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// 首读的临时 IO 失败未必产生失效信号；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;

function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionState {
  return enabled && service
    ? { status: "loading" }
    : { status: "unavailable", reason: unavailableReason };
}

/**
 * 模型选择的唯一 renderer 读取入口。
 *
 * 契约只有一条：`onDidChange` 是**失效信号**（不携带快照）。收到后重新 `getView()`；
 * 读取成功 = ready，读取失败 = error（可见、可重试），不会保留上一次的 ready 冒充当前事实。
 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(normalizedService, enabled, unavailableReason);

  useEffect(() => {
    const owner = { service: normalizedService, enabled, unavailableReason, inputKey };
    let disposed = false;
    let request = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    setOwned({
      ...owner,
      state: initialState(normalizedService, enabled, unavailableReason),
    });
    if (!enabled || !normalizedService) return;

    const read = (): void => {
      cancelRetry();
      const current = ++request;
      setOwned({ ...owner, state: { status: "loading" } });
      void normalizedService.getView(stableInput).then(
        (view) => {
          if (disposed || current !== request) return;
          setOwned({ ...owner, state: { status: "ready", view } });
        },
        (cause: unknown) => {
          if (disposed || current !== request) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          setOwned({ ...owner, state: { status: "error", error } });
          const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
          if (delay !== undefined && isTransientReadError(cause)) {
            retryCount += 1;
            retryTimer = setTimeout(read, delay);
          }
        },
      );
    };
    let subscription: { dispose(): void };
    try {
      subscription = normalizedService.onDynamicDidChange({
        workspacePath: stableInput?.workspacePath,
      })(read);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[model-selection] 目标 Host watch 订阅失败", { error });
      setOwned({ ...owner, state: { status: "error", error } });
      return;
    }
    read();
    return () => {
      disposed = true;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, unavailableReason, inputKey, stableInput]);

  return { state: visibleState, reload: useCallback(() => reload(), []) };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
