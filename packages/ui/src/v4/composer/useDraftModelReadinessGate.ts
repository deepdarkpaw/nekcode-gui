import { useCallback, useEffect, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  buildModelConfigMissingUiError,
  buildModelConfigUnreadableUiError,
} from "@/lib/chatPrepareError.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessGate {
  /** 只有 readiness 已确认时，才允许进入 workspace prepare/prewarm。 */
  agentStartupAllowed: boolean;
  error: ZCodeUiError | null;
  /** 只关闭横幅：不改词 admission 事实（被拦住的状态仍然拦住首发）。 */
  dismissError(): void;
  /** 重新读取事实来源（读取失败/配置刚被修好时使用）。 */
  retry(): void;
  /** 首发 admission 的权威复查；false 表示应保留 composer 并返回 blocked。 */
  ensureReadyForSend(): Promise<boolean>;
  /** Host 门禁在 UI 复查后竞态命中时，把同一裁决重新投影到草稿横幅。 */
  markProviderNotReady(): void;
}

interface GateState {
  readonly key: string;
  /** 用户关掉了横幅。只影响展示。 */
  readonly dismissed: boolean;
  /** Host 拒绝过本次草稿：事实没变之前不能因为“关掉横幅”就放行。 */
  readonly blocked: boolean;
  /** 首发复查得到的读取失败。 */
  readonly failure: Error | null;
}

const INITIAL_GATE_STATE = { dismissed: false, blocked: false, failure: null } as const;

function readinessOf(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * V4 草稿的 provider/model admission。
 *
 * 模型事实只有一份：目标 Host 的 `ModelSelectionService.getView()`（生产环境由 nek 的
 * models.json / settings.json 与控制进程模型目录派生）。这里不读 GUI registry，也不向
 * Agent 服务另问一次“有没有模型”。
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: IModelSelectionService | null;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${displayProvider}`;
  // 与 Composer/Submission 同一次 getView（同一个 workspace 根，项目级配置合并一致）。
  const read = useModelSelectionServiceView(modelSelectionService, enabled, "remote-waiting", {
    selection: null,
    workspacePath,
  });
  const [state, setState] = useState<GateState>(() => ({ key: gateKey, ...INITIAL_GATE_STATE }));
  const current = state.key === gateKey ? state : { key: gateKey, ...INITIAL_GATE_STATE };
  const readFailure = read.state.status === "error" ? read.state.error : null;
  const failure = current.failure ?? readFailure;

  // 只有读取结果本身变了（就绪/失败/版本）才是一次新裁决；同内容重读不能把用户关掉的
  // 横幅或 Host 的拒绝抹掉。
  const readStatus = read.state.status;
  const readRevision = read.state.status === "ready" ? read.state.view.revision : null;
  useEffect(() => {
    setState((previous) =>
      previous.key === gateKey &&
      (previous.dismissed || previous.blocked || previous.failure !== null)
        ? { key: gateKey, ...INITIAL_GATE_STATE }
        : previous,
    );
  }, [gateKey, readStatus, readRevision]);

  const status: DraftModelReadinessStatus = !enabled
    ? "ready"
    : current.blocked
      ? "missing"
      : failure
        ? "check-failed"
        : read.state.status === "ready"
          ? readinessOf(read.state.view)
          : // 无目标（未选 workspace）时门禁不参与；尚未读到结果时只是“检查中”。
            read.state.status === "unavailable"
            ? "ready"
            : "checking";

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled || !modelSelectionService) return true;
    try {
      const view = await modelSelectionService.getView({ selection: null, workspacePath });
      if (readinessOf(view) === "ready") {
        setState({ key: gateKey, ...INITIAL_GATE_STATE });
        return true;
      }
      logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
        providerCount: view.providers.length,
        revision: view.revision,
        workspacePath,
      });
      setState({ key: gateKey, ...INITIAL_GATE_STATE });
      // 让共享 Read 重新读取，横幅跟随同一次 getView 的结果。
      read.reload();
      return false;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.warn("[v4-draft-readiness] 首发复查模型事实失败", {
        error: normalized.message,
        workspacePath,
      });
      setState({ key: gateKey, ...INITIAL_GATE_STATE, failure: normalized });
      return false;
    }
  }, [enabled, gateKey, modelSelectionService, read, workspacePath]);

  const dismissError = useCallback(() => {
    // 只改展示：blocked/失败/缺模型的判断不变，首发仍然被拦住，直到事实变化或用户重试成功。
    setState((previous) => {
      const base = previous.key === gateKey ? previous : { key: gateKey, ...INITIAL_GATE_STATE };
      return { ...base, dismissed: true };
    });
  }, [gateKey]);

  const retry = useCallback(() => {
    setState({ key: gateKey, ...INITIAL_GATE_STATE });
    read.reload();
  }, [gateKey, read]);

  const markProviderNotReady = useCallback(() => {
    // 不在这里重读：事实没变时重读只会把同一条裁决再抹掉一次。下一次失效信号或用户
    // 重试/再发送时才重新裁决。
    setState({ key: gateKey, ...INITIAL_GATE_STATE, blocked: true });
  }, [gateKey]);

  return {
    agentStartupAllowed: !enabled || status === "ready",
    error: !enabled || current.dismissed ? null : errorFor(status, failure),
    dismissError,
    retry,
    ensureReadyForSend,
    markProviderNotReady,
  };
}

function errorFor(status: DraftModelReadinessStatus, failure: Error | null): ZCodeUiError | null {
  if (status === "missing") return buildModelConfigMissingUiError();
  if (status === "check-failed") return buildModelConfigUnreadableUiError(failure);
  return null;
}
