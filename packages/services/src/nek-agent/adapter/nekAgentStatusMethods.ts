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

/** 薄壳依赖的适配器内部面：服务实例与按需恢复。 */
interface NekAgentStatusSurface {
  service: NekAgentService;
  ensureNekSessionBinding(
    target: NekWorkspaceTarget,
    sessionId: string,
  ): Promise<NekSessionBinding>;
}

/** `Object.assign` 挂到适配器上的状态方法（适配器用 `declare readonly` 补接口类型）。 */
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

/**
 * 建状态 feed：`channel` 由适配器在 create/resume/close/dispose 时驱动，
 * `methods` 经 Object.assign 挂到适配器上暴露给 renderer。
 */
export function createNekAgentStatusFeed(
  surface: NekAgentStatusSurface,
  logger?: NekStatusChannelLogger,
): { channel: NekAgentStatusChannel; methods: NekAgentStatusMethods } {
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
  return {
    channel,
    methods: createNekAgentStatusMethods(
      service,
      (target, sessionId) => surface.ensureNekSessionBinding(target, sessionId),
      channel,
      readSnapshot,
    ),
  };
}

function createNekAgentStatusMethods(
  service: NekAgentService,
  ensureNekSessionBinding: NekAgentStatusSurface["ensureNekSessionBinding"],
  channel: NekAgentStatusChannel,
  readSnapshot: (sessionKey: string) => Promise<NekStatusSnapshot>,
): NekAgentStatusMethods {
  /** renderer 的 sessionId → 服务内部会话键；历史会话按需恢复后再执行动作。 */
  const sessionKeyOf = async (
    params: NekWorkspaceTarget & { sessionId: string },
  ): Promise<string> => (await ensureNekSessionBinding(params, params.sessionId)).sessionKey;
  return {
    onDynamicNekStatusFrame: (target) => channel.onDynamic(target),
    getNekStatusSnapshot: async (params): Promise<NekStatusSnapshot> =>
      boundNekStatusSnapshot(await readSnapshot(await sessionKeyOf(params))),
    getNekSessionStats: async (params): Promise<NekSessionStats> =>
      await service.getStats(await sessionKeyOf(params)),
    clearNekQueue: async (params): Promise<NekStatusQueue> =>
      boundNekStatusQueue(await service.clearQueue(await sessionKeyOf(params))),
    requeueNekQueue: async (params): Promise<void> => {
      const sessionKey = await sessionKeyOf(params);
      const queue = params.queue.inputs ? boundNekStatusQueue(params.queue) : params.queue;
      await service.runSessionCommand(
        sessionKey,
        async (context) => await commands.requeueQueue(context, sessionKey, queue),
      );
    },
    abortNekRetry: async (params): Promise<void> => {
      const sessionKey = await sessionKeyOf(params);
      await service.runSessionCommand(
        sessionKey,
        async (context) => await commands.abortRetry(context, sessionKey),
      );
    },
    abortNekCompaction: async (params): Promise<void> =>
      await service.abort(await sessionKeyOf(params)),
    abortNekSession: async (params): Promise<void> =>
      await service.abort(await sessionKeyOf(params)),
    compactNekSession: async (params): Promise<void> => {
      await service.compact({ sessionKey: await sessionKeyOf(params) });
    },
  };
}
