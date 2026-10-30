/**
 * NekAgentService 的装配件：进程池、投影器，以及共用的命令分类与展示标签。
 *
 * 这些都属于"按运行参数构造/映射一件事"，放在这里让
 * `nekAgentServiceRuntimeMethods.ts` 只保留会话状态机本身（该文件已接近 400 行上限）。
 */
import type { GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type { NekInteractionScope, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../nekConversationProjector.js";
import type { NekRpcClientOptions } from "../nekRpcClient.js";
import { NekProcessPool } from "../nekProcessPool.js";
import { createNekRpcProcess, type NekRpcProcess } from "../nekRpcProcess.js";
import type {
  NekAgentServiceOptions,
  NekSessionProcessCreateOptions,
  NekSessionRecord,
} from "./types.js";

interface NekAgentProcessPoolOptions {
  config: GuiRuntimeConfig;
  logger: NekAgentServiceOptions["logger"];
  defaultCwd: string;
  /** 服务构造入参：注入的进程工厂与 guiInfo 都在这里。 */
  serviceOptions: NekAgentServiceOptions;
  pendingCreates: Map<string, NekSessionProcessCreateOptions>;
  createSessionProcess: (request: NekSessionProcessCreateOptions) => Promise<NekRpcProcess>;
  clientOptions: (scope: NekInteractionScope) => Omit<NekRpcClientOptions, "logger">;
}

/** 会话进程池：上限与空闲回收来自 GUI 运行参数，控制进程每台机器一个。 */
export function createNekAgentProcessPool(
  options: NekAgentProcessPoolOptions,
): NekProcessPool<NekRpcProcess> {
  const { serviceOptions } = options;
  return new NekProcessPool<NekRpcProcess>({
    maxSessions: options.config.nek.maxSessionProcesses,
    idleTimeoutMs: options.config.nek.idleMinutes * 60_000,
    createSessionProcess: async (sessionKey) => {
      const request = options.pendingCreates.get(sessionKey);
      if (!request) throw new Error(`no create options for nek session ${sessionKey}`);
      return await options.createSessionProcess(request);
    },
    createControlProcess: async () => {
      if (serviceOptions.createControlProcess) return await serviceOptions.createControlProcess();
      if (!serviceOptions.guiInfo)
        throw new Error("nek guiInfo or createControlProcess is required");
      return createNekRpcProcess({
        guiInfo: serviceOptions.guiInfo,
        cwd: options.defaultCwd,
        control: true,
        client: options.clientOptions({ workspacePath: options.defaultCwd }),
        logger: options.logger,
      });
    },
    logger: options.logger,
  });
}

/** 投影器：流式合并频率与事件窗口上限都来自 GUI 运行参数。 */
export function createNekConversationProjector(options: {
  config: GuiRuntimeConfig;
  logger: NekAgentServiceOptions["logger"];
  record: NekSessionRecord;
}): NekConversationProjector {
  return new NekConversationProjector({
    sessionId: options.record.sessionId,
    streamFlushIntervalMs: Math.max(
      1,
      Math.floor(1000 / options.config.events.streamFlushPerSecond),
    ),
    maxWindowRows: options.config.events.eventBufferEntries,
    logger: options.logger,
  });
}

/** 需要长超时的命令：这些命令等的是整轮工作（压缩、登录、拉模型、测试），不是一次握手。 */
export const NEK_LONG_RUNNING_COMMANDS = [
  "compact",
  "export_session",
  "share_session",
  "navigate_tree",
  "fork",
  "clone",
  "import_session",
  "auth_login",
  "fetch_provider_models",
  "test_provider",
  "test_web_search",
  "mcp_test",
] as const;

/**
 * 锁持有者的人类可读描述（只用于错误与展示）：`nek tui (host:pid)`。
 *
 * nek 不报持有者时退回 `"nek"`：那时候只知道"有进程占着锁"。
 */
export function nekLockLabel(holder: NekSessionSnapshot["lockedBy"]): string {
  if (!holder) return "nek";
  return `nek ${holder.kind} (${holder.hostname}:${holder.pid})`;
}
