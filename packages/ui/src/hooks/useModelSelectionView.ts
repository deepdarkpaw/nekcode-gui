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
    let active = false;
    let dirty = false;
    let batchStartedAt = Date.now();
    setOwned({
      ...owner,
      state: initialState(normalizedService, enabled, unavailableReason),
    });
    if (!enabled || !normalizedService) return;

    const read = (followUp = false): void => {
      if (!followUp) batchStartedAt = Date.now();
      active = true;
      dirty = false;
      const current = ++request;
      setOwned({ ...owner, state: { status: "loading" } });
      void normalizedService.getView(stableInput, { elapsedMs: Date.now() - batchStartedAt }).then(
        (view) => {
          if (disposed || current !== request) return;
          active = false;
          if (dirty && !followUp) {
            read(true);
            return;
          }
          if (dirty) {
            setOwned({
              ...owner,
              state: {
                status: "error",
                error: new Error("Model configuration kept changing; retry the read"),
              },
            });
            return;
          }
          setOwned({ ...owner, state: { status: "ready", view } });
        },
        (cause: unknown) => {
          if (disposed || current !== request) return;
          active = false;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          setOwned({ ...owner, state: { status: "error", error } });
        },
      );
    };
    const invalidate = (): void => {
      if (disposed) return;
      if (active) {
        dirty = true;
        return;
      }
      read();
    };
    let subscription: { dispose(): void };
    try {
      subscription = normalizedService.onDynamicDidChange({
        workspacePath: stableInput?.workspacePath,
      })(invalidate);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[model-selection] 目标 Host watch 订阅失败", { error });
      setOwned({ ...owner, state: { status: "error", error } });
      return;
    }
    read();
    return () => {
      disposed = true;
      request += 1;
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
