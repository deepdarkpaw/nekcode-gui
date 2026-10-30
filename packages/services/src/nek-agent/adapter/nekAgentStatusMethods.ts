/**
 * nek status feed 面向 renderer 的薄壳。
 *
 * 与 legacy 方法同样通过 `Object.assign` 挂到适配器上：适配器只保留连接/对话/附件的竖切逻辑，
 * 状态动作在这里做"绑定解析 → 有界化 → 命令层"三步。
 * nek 没有独立的"取消压缩"命令：压缩跟随同一个 abort 信号，因此取消压缩与停止回合共用 abort。
 */
import type {
  NekSessionStats,
  NekStatusQueue,
  NekStatusSnapshot,
} from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import * as commands from "../service/nekAgentServiceCommands.js";
import type { NekAgentService } from "../service/nekAgentService.js";
import {
  boundNekStatusQueue,
  boundNekStatusSnapshot,
  NekAgentStatusChannel,
  type NekStatusChannelLogger,
} from "./nekAgentStatusChannel.js";
import type { NekSessionBinding, NekWorkspaceTarget } from "./types.js";

/** 薄壳依赖的适配器内部面：服务实例与绑定解析。 */
export interface NekAgentStatusSurface {
  service: NekAgentService;
  requireBinding(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding;
}

/** `Object.assign` 挂到适配器上的状态方法；类型由适配器文件的合并接口声明。 */
export interface NekAgentStatusMethods {
  onDynamicNekStatusFrame: IZCodeAgentService["onDynamicNekStatusFrame"];
  getNekStatusSnapshot: IZCodeAgentService["getNekStatusSnapshot"];
  getNekSessionStats: IZCodeAgentService["getNekSessionStats"];
  clearNekQueue: IZCodeAgentService["clearNekQueue"];
  requeueNekQueue: IZCodeAgentService["requeueNekQueue"];
  abortNekRetry: IZCodeAgentService["abortNekRetry"];
  abortNekCompaction: IZCodeAgentService["abortNekCompaction"];
  abortNekSession: IZCodeAgentService["abortNekSession"];
  compactNekSession: IZCodeAgentService["compactNekSession"];
}

/** 状态 feed 的两块产物：帧通道（打开/关闭/释放由适配器触发）与 RPC 方法。 */
export interface NekAgentStatusFeedParts {
  channel: NekAgentStatusChannel;
  methods: NekAgentStatusMethods;
}

export function createNekAgentStatusFeed(
  surface: NekAgentStatusSurface,
  logger?: NekStatusChannelLogger,
): NekAgentStatusFeedParts {
  const { service } = surface;
  /** 权威快照：只读会话没有活进程，`commands.getStatusSnapshot` 会直接报错。 */
  const readSnapshot = async (sessionKey: string): Promise<NekStatusSnapshot> =>
    await service.runSessionCommand(
      sessionKey,
      async (context) => await commands.getStatusSnapshot(context, sessionKey),
    );
  const channel = new NekAgentStatusChannel(
    {
      onEvent: (listener) => service.onEvent(listener),
      listOpenSessions: (cwd) => service.listOpenSessions(cwd),
      getStatusSnapshot: readSnapshot,
    },
    logger,
  );
  return { channel, methods: createNekAgentStatusMethods(surface, channel, readSnapshot) };
}

export function createNekAgentStatusMethods(
  surface: NekAgentStatusSurface,
  channel: NekAgentStatusChannel,
  readSnapshot: (sessionKey: string) => Promise<NekStatusSnapshot>,
): NekAgentStatusMethods {
  const { service } = surface;
  /** renderer 的 sessionId → 服务内部会话键；未打开的会话直接报错（不落的兜底）。 */
  const sessionKeyOf = (params: NekWorkspaceTarget & { sessionId: string }): string =>
    surface.requireBinding(params, params.sessionId).sessionKey;
  return {
    onDynamicNekStatusFrame: (target) => channel.onDynamic(target),
    getNekStatusSnapshot: async (params): Promise<NekStatusSnapshot> =>
      boundNekStatusSnapshot(await readSnapshot(sessionKeyOf(params))),
    getNekSessionStats: async (params): Promise<NekSessionStats> =>
      await service.getStats(sessionKeyOf(params)),
    clearNekQueue: async (params): Promise<NekStatusQueue> =>
      boundNekStatusQueue(await service.clearQueue(sessionKeyOf(params))),
    requeueNekQueue: async (params): Promise<void> => {
      const sessionKey = sessionKeyOf(params);
      await service.runSessionCommand(
        sessionKey,
        async (context) => await commands.requeueQueue(context, sessionKey, params.queue),
      );
    },
    abortNekRetry: async (params): Promise<void> => {
      const sessionKey = sessionKeyOf(params);
      await service.runSessionCommand(
        sessionKey,
        async (context) => await commands.abortRetry(context, sessionKey),
      );
    },
    abortNekCompaction: async (params): Promise<void> => await service.abort(sessionKeyOf(params)),
    abortNekSession: async (params): Promise<void> => await service.abort(sessionKeyOf(params)),
    compactNekSession: async (params): Promise<void> => {
      await service.compact({ sessionKey: sessionKeyOf(params) });
    },
  };
}
