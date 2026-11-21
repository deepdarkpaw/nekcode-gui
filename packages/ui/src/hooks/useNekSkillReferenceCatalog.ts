import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSkillReferenceCatalogEntry, ZCodeSlashCommand } from "@zcode/shared";
import type { NekMentionTarget } from "@zcode/shared/nek-protocol";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface ConversationSkillCatalogState {
  skills: ZCodeSkillReferenceCatalogEntry[];
  agents?: NekMentionTarget[];
  commands?: ZCodeSlashCommand[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface ScopedConversationSkillCatalogState {
  scope: object | null;
  value: ConversationSkillCatalogState;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  loading: false,
  error: null,
};

const EMPTY_SCOPED_STATE: ScopedConversationSkillCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string;
  includeSlashCatalog?: boolean;
}

/**
 * Composer 的 Skill catalog。
 * 无会话的草稿查询目标 nek 控制进程；已有会话查询其 `get_mention_targets`。
 * workspace/session/远程连接/runtime 代次变化时，
 * 旧异步结果一律不得回填。
 */
export function useNekSkillReferenceCatalog(
  options: UseSkillsOptions,
): ConversationSkillCatalogState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.preferredRemoteSessionId,
    options.workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedConversationSkillCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options.preferredRemoteSessionId ?? undefined;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${options.sessionId ?? "draft"}|runtime:${runtimeRevision}`;

  useEffect(() => {
    if (!options.enabled || !options.sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // runtime 重建后 workspace/session key 不变，旧 catalog 会继续命中。
      // 显式推进代次，使冷恢复后的新 runtime 必须重新提供一次 Session authority。
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [options.enabled, options.sessionId, rpcReady, services, workspaceKey]);

  // 用 scope 身份隔离渲染：key 切换后的 effect 尚未执行时也只返回空态，避免旧 Session
  // 或旧 remote attachment 的 Skill 在一帧内泄漏到新 Composer。
  const requestScope = useMemo(
    () => ({}),
    [options.enabled, remoteSessionId, requestKey, rpcReady, services],
  );

  useEffect(() => {
    if (!options.enabled || !options.workspacePath || !rpcReady) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { skills: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.includeSlashCatalog ? { includeSlashCatalog: true } : {}),
    };
    services.zcodeAgentService
      .getSkillReferenceCatalog(params)
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            ...result,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useNekSkillReferenceCatalog] 拉取对话 Skill catalog 失败", {
          error: message,
          requestKey,
        });
        setScopedState({
          scope: requestScope,
          value: { skills: [], authority: null, loading: false, error: message },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.enabled,
    options.includeSlashCatalog,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
  ]);

  if (
    !options.enabled ||
    !options.workspacePath ||
    !rpcReady ||
    scopedState.scope !== requestScope
  ) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
