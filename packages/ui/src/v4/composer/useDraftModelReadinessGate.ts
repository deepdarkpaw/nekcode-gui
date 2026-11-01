import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  buildModelConfigMissingUiError,
  buildModelConfigUnreadableUiError,
} from "@/lib/chatPrepareError.js";
import { useModelSelectionServiceView, type ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessGate {
  agentStartupAllowed: boolean;
  error: ZCodeUiError | null;
  /** Dismissing presentation never changes admission. */
  dismissError(): void;
  retry(): void;
  ensureReadyForSend(): Promise<boolean>;
  markProviderNotReady(): void;
}

interface GateState {
  readonly owner: object;
  readonly observation: ModelSelectionState;
  readonly dismissed: boolean;
  readonly blocked: boolean;
  readonly failure: Error | null;
}

const INITIAL_GATE_STATE = { dismissed: false, blocked: false, failure: null } as const;

function readinessOf(view: ModelSelectionView): "ready" | "missing" {
  return view.providers.some((provider) => provider.models.some((model) => model.reasoningLevels.length > 0))
    ? "ready"
    : "missing";
}

/** Admission reads only the target Host view. Catalog revision is NOT a recovery token. */
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
  const owner = useMemo(() => ({}), [workspacePath, workspaceIdentity, displayProvider, sessionId, modelSelectionService]);
  const read = useModelSelectionServiceView(modelSelectionService, enabled, "remote-waiting", {
    selection: null,
    workspacePath,
  });
  const observation = read.state;
  const active = useRef<{ owner: object; observation: ModelSelectionState } | null>(null);
  active.current = { owner, observation };
  useEffect(() => {
    active.current = { owner, observation };
    return () => { active.current = null; };
  }, [owner, observation]);
  const sendEpoch = useRef(0);
  const initial = { owner, observation, ...INITIAL_GATE_STATE };
  const [state, setState] = useState<GateState>(initial);
  // A newly successful read is a new adjudication, even when only workspace defaults changed.
  // Loading/error never silently clears a Host refusal or a failed send recheck.
  const current = state.owner === owner && (observation.status !== "ready" || state.observation === observation)
    ? state
    : initial;
  const failure = observation.status === "error" ? observation.error : current.failure;
  const status: DraftModelReadinessStatus = !enabled
    ? "ready"
    : failure
      ? "check-failed"
      : observation.status === "loading"
        ? "checking"
        : current.blocked
          ? "missing"
          : observation.status === "ready"
            ? readinessOf(observation.view)
            : "checking";

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    if (!modelSelectionService) return false;
    const request = ++sendEpoch.current;
    const isCurrent = () => active.current?.owner === owner && active.current.observation === observation && request === sendEpoch.current;
    try {
      const view = await modelSelectionService.getView({ selection: null, workspacePath });
      if (!isCurrent()) return false;
      if (readinessOf(view) === "ready") {
        setState({ owner, observation, ...INITIAL_GATE_STATE });
        return true;
      }
      setState({ owner, observation, ...INITIAL_GATE_STATE, blocked: true });
      read.reload();
      return false;
    } catch (error) {
      if (!isCurrent()) return false;
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.warn("[v4-draft-readiness] 首发复查模型事实失败", { error: normalized.message, workspacePath });
      setState({ owner, observation, ...INITIAL_GATE_STATE, failure: normalized });
      return false;
    }
  }, [enabled, modelSelectionService, owner, observation, read.reload, workspacePath]);

  const dismissError = useCallback(() => {
    setState({ ...current, dismissed: true });
  }, [current]);

  const retry = useCallback(() => {
    // Do not release a refusal until the replacement read actually succeeds.
    read.reload();
  }, [read.reload]);

  const markProviderNotReady = useCallback(() => {
    setState({ owner, observation, ...INITIAL_GATE_STATE, blocked: true });
  }, [owner, observation]);

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
