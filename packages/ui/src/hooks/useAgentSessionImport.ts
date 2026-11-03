/**
 * 把各项目 agent 会话目录里还没进 tasks-index 的会话（例如在终端里用 CLI 建的会话）导入侧栏。
 *
 * 侧栏以 tasks-index 行为持久集合；GUI 没打开过会话的项目不会建立 sessions-index 摄入，
 * CLI 会话因此一直显示“暂无任务”。这里只负责触发 host 的一次性导入：
 * - 项目出现在侧栏（首次挂载、新增项目）时导入一次，当前项目优先；
 * - 窗口回到前台时（用户可能刚在终端里用过 CLI）全部项目再导入一轮，轮次之间节流。
 * 有新增行时 host 广播 task_created，侧栏按既有归属事件换代重读；这里不直接改列表状态。
 */
import { useEffect, useMemo, useRef } from "react";
import type { IZCodeTaskService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

/** 窗口回到前台触发的导入轮次最小间隔。 */
export const AGENT_SESSION_IMPORT_FOCUS_INTERVAL_MS = 15_000;
/** 同时进行的导入请求数：会话目录读取走同一个 agent 控制进程，不并发打满。 */
const IMPORT_CONCURRENCY = 2;

interface AgentSessionImportScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AgentSessionImportShard {
  shardKey: string;
  service: Pick<IZCodeTaskService, "importAgentSessions">;
  scopes: readonly AgentSessionImportScope[];
}

interface ImportTarget {
  key: string;
  service: Pick<IZCodeTaskService, "importAgentSessions">;
  scope: AgentSessionImportScope;
}

function collectImportTargets(
  shards: readonly AgentSessionImportShard[],
  activeWorkspaceKey: string,
): ImportTarget[] {
  const targets = new Map<string, ImportTarget & { active: boolean }>();
  for (const shard of shards) {
    for (const scope of shard.scopes) {
      const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
      const key = `${shard.shardKey}::${workspaceKey}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        key,
        service: shard.service,
        scope,
        active: workspaceKey === activeWorkspaceKey,
      });
    }
  }
  // 当前项目先导入，其余项目沿侧栏顺序跟上。
  return [...targets.values()]
    .sort((left, right) => Number(right.active) - Number(left.active))
    .map(({ key, service, scope }) => ({ key, service, scope }));
}

async function importTargets(targets: readonly ImportTarget[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const target = targets[next];
      next += 1;
      if (!target) return;
      try {
        await target.service.importAgentSessions(target.scope);
      } catch (error) {
        logger.warn(
          `[useAgentSessionImport] 导入会话目录失败 workspace=${target.scope.workspacePath}`,
          error,
        );
      }
    }
  };
  const workers = Math.min(IMPORT_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

export function useAgentSessionImport(
  shards: readonly AgentSessionImportShard[],
  activeWorkspaceKey: string,
): void {
  const targets = useMemo(
    () => collectImportTargets(shards, activeWorkspaceKey),
    [activeWorkspaceKey, shards],
  );
  const targetSignature = useMemo(
    () =>
      targets
        .map((target) => target.key)
        .sort()
        .join("|"),
    [targets],
  );
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  /** 已导入过的 endpoint + 项目；移出侧栏后删除，重新加入时再导入。 */
  const importedKeysRef = useRef(new Set<string>());
  const lastFocusRoundAtRef = useRef(0);

  useEffect(() => {
    const current = targetsRef.current;
    const imported = importedKeysRef.current;
    const currentKeys = new Set(current.map((target) => target.key));
    for (const key of imported) {
      if (!currentKeys.has(key)) imported.delete(key);
    }
    const fresh = current.filter((target) => !imported.has(target.key));
    if (fresh.length === 0) return;
    for (const target of fresh) imported.add(target.key);
    void importTargets(fresh);
  }, [targetSignature]);

  useEffect(() => {
    // 挂载时已按项目导入过一轮；随后马上到来的首个 focus 不必再扫一遍。
    lastFocusRoundAtRef.current = Date.now();
    const importOnForeground = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusRoundAtRef.current < AGENT_SESSION_IMPORT_FOCUS_INTERVAL_MS) return;
      lastFocusRoundAtRef.current = now;
      void importTargets(targetsRef.current);
    };
    window.addEventListener("focus", importOnForeground);
    document.addEventListener("visibilitychange", importOnForeground);
    return () => {
      window.removeEventListener("focus", importOnForeground);
      document.removeEventListener("visibilitychange", importOnForeground);
    };
  }, []);
}
