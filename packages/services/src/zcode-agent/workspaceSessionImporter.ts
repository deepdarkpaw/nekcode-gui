/**
 * 会话目录 → task index 的一次性导入：把 agent 会话目录里还没有 task 行的会话补进来。
 *
 * 侧栏以 task 行为持久集合，只有 GUI 自己打开过会话的项目才会建立 sessions-index 订阅；
 * 在终端里用 CLI 建的会话（已有的、或 GUI 运行期间新建的）不会经过那条路径。渲染层在
 * 列出项目、窗口重新获得焦点时调用这里：只读会话目录（`existing-only`，不拉起会话进程），
 * 只补缺失行，有新增时广播一次 task_created 让侧栏重读。
 *
 * 有界：同一项目并发调用合并成一次；刚导入过的项目在最小间隔内直接返回；记账表按 LRU 截断。
 */
import { resolveWorkspaceKey } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { isZCodeAgentRuntimeUnavailableError } from "./runtimeUnavailableError.js";
import {
  isImportableSessionInfo,
  seedMissingTaskRows,
  taskMetaFromSessionInfo,
} from "./taskIndexRowSeeding.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";

const logger = createServiceLogger("workspace-session-importer");

/** 同一项目两次导入的最小间隔：窗口焦点抖动、多窗口挂载不会反复扫目录。 */
export const WORKSPACE_SESSION_IMPORT_MIN_INTERVAL_MS = 3_000;
/** 记账表（最近导入时间）与并发导入的上限。 */
const WORKSPACE_SESSION_IMPORT_MAX_WORKSPACES = 256;

type WorkspaceSessionImportResult =
  | { status: "imported"; inserted: number }
  | { status: "skipped"; reason: "recent" | "runtime-unavailable" };

/** 返回值形状：只有本模块构造实例，调用方按结构使用。 */
interface WorkspaceSessionImporter {
  importWorkspaceSessions(target: ZCodeAgentWorkspaceTarget): Promise<WorkspaceSessionImportResult>;
}

interface WorkspaceSessionImporterOptions {
  agentService: Pick<IZCodeAgentService, "listSessions">;
  taskIndexRepo: Pick<TaskIndexRepo, "seedTaskMetaIfMissing">;
  /** 有新增行时调用一次（广播 task_created）。 */
  onRowsInserted: (target: ZCodeAgentWorkspaceTarget) => void;
  now?: () => number;
}

export function createWorkspaceSessionImporter(
  options: WorkspaceSessionImporterOptions,
): WorkspaceSessionImporter {
  const now = options.now ?? Date.now;
  const flights = new Map<string, Promise<WorkspaceSessionImportResult>>();
  const lastImportedAt = new Map<string, number>();

  /** Map 插入序即 LRU 序：重新写入把该项目挪到最新，超限淘汰最旧的。 */
  const rememberImport = (key: string): void => {
    lastImportedAt.delete(key);
    lastImportedAt.set(key, now());
    while (lastImportedAt.size > WORKSPACE_SESSION_IMPORT_MAX_WORKSPACES) {
      const oldest = lastImportedAt.keys().next().value;
      if (oldest === undefined) return;
      lastImportedAt.delete(oldest);
    }
  };

  const runImport = async (
    target: ZCodeAgentWorkspaceTarget,
  ): Promise<WorkspaceSessionImportResult> => {
    let sessions;
    try {
      sessions = await options.agentService.listSessions({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      // 这类 agent 只有 runtime 在时才能列会话；runtime 出现后由 sessions-index 订阅补齐。
      if (isZCodeAgentRuntimeUnavailableError(error)) {
        return { status: "skipped", reason: "runtime-unavailable" };
      }
      throw error;
    }
    const metas = sessions
      .filter((session) => isImportableSessionInfo(target, session))
      .map((session) => taskMetaFromSessionInfo(target, session));
    const result = await seedMissingTaskRows(options.taskIndexRepo, metas);
    if (result.failed > 0) {
      logger.warn(
        undefined,
        `会话目录导入 task index 失败 workspace=${resolveWorkspaceKey(target)} failed=${result.failed} total=${metas.length}`,
        result.firstError,
      );
    }
    if (result.inserted > 0) options.onRowsInserted(target);
    return { status: "imported", inserted: result.inserted };
  };

  return {
    async importWorkspaceSessions(target) {
      if (!target.workspacePath) throw new Error("workspacePath is required");
      const key = resolveWorkspaceKey(target);
      const pending = flights.get(key);
      if (pending) return await pending;
      const last = lastImportedAt.get(key);
      if (last !== undefined && now() - last < WORKSPACE_SESSION_IMPORT_MIN_INTERVAL_MS) {
        return { status: "skipped", reason: "recent" };
      }
      if (flights.size >= WORKSPACE_SESSION_IMPORT_MAX_WORKSPACES) {
        throw new Error(
          `too many concurrent session imports (${WORKSPACE_SESSION_IMPORT_MAX_WORKSPACES})`,
        );
      }
      const flight = runImport(target);
      flights.set(key, flight);
      try {
        const result = await flight;
        rememberImport(key);
        return result;
      } finally {
        flights.delete(key);
      }
    },
  };
}
