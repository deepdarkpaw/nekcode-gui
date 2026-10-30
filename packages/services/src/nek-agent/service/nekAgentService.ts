import { randomUUID } from "node:crypto";
import type {
  NekExtensionUiResponse,
  NekInteractionFrame,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentServiceCommandMethods } from "./nekAgentServiceCommandMethods.js";
import * as commands from "./nekAgentServiceCommands.js";
import type { NekAgentCommandContext, NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { NekAgentServiceRuntimeBase } from "./nekAgentServiceRuntimeMethods.js";

/** 在会话租约内执行的一次命令实现（`runSessionCommand` 的入参形状）。 */
export type NekAgentCommandRunner<T> = (context: NekAgentCommandContext) => Promise<T>;
import {
  isNekSessionSnapshot,
  type NekAgentServiceOptions,
  type NekConversationListener,
  type NekMode,
  type NekSession,
  type NekSessionListOptions,
  type NekSessionRecord,
  type NekSessionResult,
  type NekThoughtLevel,
} from "./types.js";
/**
 * GUI 对 nek RPC 的唯一会话所有者；不实现 `IZCodeAgentService`。
 *
 * 会话生命周期方法与命令方法都在这里对外暴露：命令实现落在 `nekAgentServiceCommands.ts`
 * （无状态的 RPC 调用），进程与投影器接线落在 `NekAgentServiceRuntimeBase`。
 * 每个命令都通过 `withSession` 持有一次进程引用，命令结束即归还，空闲进程因此可以被进程池回收。
 */
export class NekAgentService
  extends NekAgentServiceRuntimeBase
  implements NekAgentServiceCommandMethods
{
  constructor(options: NekAgentServiceOptions) {
    super(options);
  }
  /**
   * 渲染层订阅交互帧（nek 的 dialog / structured / notify 都从这里出去）。
   *
   * 返回 detach；最后一个订阅者离开后，nek 侧的 dialog 请求会立刻按取消收口，
   * 不再等一个永远不会来的回答。
   */
  onInteractionEvent(listener: (frame: NekInteractionFrame) => void): () => void {
    return this.interactions.onFrame(listener);
  }

  /** 渲染层回答交互请求；未知 id（已取消或已结算）返回 `false`。 */
  respondInteraction(response: NekExtensionUiResponse): boolean {
    this.assertAlive();
    return this.interactions.respond(response);
  }

  // ---- 输入 ----

  readonly sendPrompt: NekAgentServiceCommandMethods["sendPrompt"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.sendPrompt(this.commandContext(), input),
    );

  readonly abort: NekAgentServiceCommandMethods["abort"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.abort(this.commandContext(), sessionKey),
    );

  readonly bash: NekAgentServiceCommandMethods["bash"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.bash(this.commandContext(), input),
    );

  readonly abortBash: NekAgentServiceCommandMethods["abortBash"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.abortBash(this.commandContext(), sessionKey),
    );

  readonly clearQueue: NekAgentServiceCommandMethods["clearQueue"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.clearQueue(this.commandContext(), sessionKey),
    );

  readonly retrieveQueue: NekAgentServiceCommandMethods["retrieveQueue"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.retrieveQueue(this.commandContext(), sessionKey),
    );

  // ---- 会话操作 ----

  readonly compact: NekAgentServiceCommandMethods["compact"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.compact(this.commandContext(), input),
    );

  readonly setModel: NekAgentServiceCommandMethods["setModel"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.setModel(this.commandContext(), input),
    );

  readonly cycleModel: NekAgentServiceCommandMethods["cycleModel"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.cycleModel(this.commandContext(), sessionKey),
    );

  readonly setThinkingLevel: NekAgentServiceCommandMethods["setThinkingLevel"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.setThinkingLevel(this.commandContext(), input),
    );

  readonly setThoughtLevel: NekAgentServiceCommandMethods["setThoughtLevel"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.setThinkingLevel(this.commandContext(), input),
    );

  readonly cycleThinkingLevel: NekAgentServiceCommandMethods["cycleThinkingLevel"] = async (
    sessionKey,
  ) =>
    await this.withSession(
      sessionKey,
      async () => await commands.cycleThinkingLevel(this.commandContext(), sessionKey),
    );

  readonly cycleThoughtLevel: NekAgentServiceCommandMethods["cycleThoughtLevel"] = async (
    sessionKey,
  ) =>
    await this.withSession(
      sessionKey,
      async () => await commands.cycleThinkingLevel(this.commandContext(), sessionKey),
    );

  readonly setMode: NekAgentServiceCommandMethods["setMode"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.setMode(this.commandContext(), input),
    );

  readonly getStats: NekAgentServiceCommandMethods["getStats"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.getStats(this.commandContext(), sessionKey),
    );

  /**
   * 外部命令实现（状态 feed 等）复用的会话租约入口：取记录、持进程引用、交还命令层。
   *
   * 适配器层不直接调用 protected 的 `withSession`；这里把"一次命令 = 一次租约"的规则
   * 收口到服务内部，空闲进程因此仍可被进程池回收。
   */
  runSessionCommand<T>(sessionKey: string, run: NekAgentCommandRunner<T>): Promise<T> {
    return this.withSession(sessionKey, async () => await run(this.commandContext()));
  }

  readonly getCommands: NekAgentServiceCommandMethods["getCommands"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.getCommands(this.commandContext(), sessionKey),
    );

  readonly getEntries: NekAgentServiceCommandMethods["getEntries"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.getEntries(this.commandContext(), input),
    );

  readonly getTree: NekAgentServiceCommandMethods["getTree"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.getTree(this.commandContext(), sessionKey),
    );

  readonly getForkMessages: NekAgentServiceCommandMethods["getForkMessages"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.getForkMessages(this.commandContext(), sessionKey),
    );

  /** 有会话时问会话进程，只有 cwd 时问控制进程（不占会话进程）。 */
  readonly getMentionTargets: NekAgentServiceCommandMethods["getMentionTargets"] = async (
    input,
  ) => {
    const sessionKey = typeof input === "string" ? input : input.sessionKey;
    if (!sessionKey) return await commands.getMentionTargets(this.commandContext(), input);
    return await this.withSession(
      sessionKey,
      async () => await commands.getMentionTargets(this.commandContext(), input),
    );
  };

  readonly reload: NekAgentServiceCommandMethods["reload"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.reload(this.commandContext(), sessionKey),
    );

  readonly stopSubagent: NekAgentServiceCommandMethods["stopSubagent"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.stopSubagent(this.commandContext(), input),
    );

  readonly getSubagentTranscript: NekAgentServiceCommandMethods["getSubagentTranscript"] = async (
    input,
  ) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.getSubagentTranscript(this.commandContext(), input),
    );

  readonly listAgentTypes: NekAgentServiceCommandMethods["listAgentTypes"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.listAgentTypes(this.commandContext(), sessionKey),
    );

  // ---- 会话树与历史 ----

  readonly navigateTree: NekAgentServiceCommandMethods["navigateTree"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.navigateTree(this.commandContext(), input),
    );

  readonly setEntryLabel: NekAgentServiceCommandMethods["setEntryLabel"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.setEntryLabel(this.commandContext(), input),
    );

  readonly fork: NekAgentServiceCommandMethods["fork"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.fork(this.commandContext(), input),
    );

  readonly clone: NekAgentServiceCommandMethods["clone"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.clone(this.commandContext(), sessionKey),
    );

  // ---- 导出与导入 ----

  readonly exportSession: NekAgentServiceCommandMethods["exportSession"] = async (input) =>
    await this.withSession(
      input.sessionKey,
      async () => await commands.exportSession(this.commandContext(), input),
    );

  readonly shareSession: NekAgentServiceCommandMethods["shareSession"] = async (sessionKey) =>
    await this.withSession(
      sessionKey,
      async () => await commands.shareSession(this.commandContext(), sessionKey),
    );

  /** 导入只看会话文件与目标 cwd，不依赖已打开的会话进程。 */
  readonly importSession: NekAgentServiceCommandMethods["importSession"] = async (input) =>
    await commands.importSession(this.commandContext(), input);

  // ---- 会话生命周期 ----

  getSession(sessionKey: string): NekSession | undefined {
    const record = this.resolveRecord(sessionKey);
    return record ? this.publicSession(record) : undefined;
  }

  listOpenSessions(cwd: string): NekSession[] {
    return [...this.sessions.values()]
      .filter((r) => r.cwd === cwd)
      .map((r) => this.publicSession(r));
  }

  commandContext(): NekAgentCommandContext {
    return {
      writableTarget: (sessionKey) => this.commandTarget(sessionKey, true),
      target: (sessionKey) => this.commandTarget(sessionKey, false),
      control: async () => (await this.pool.ensureControl()).client,
    };
  }

  /** 新会话：先问项目信任，再带 `--approve` / `--no-approve` 启动会话进程。 */
  async createSession(input: {
    cwd: string;
    model?: { provider: string; modelId: string };
    thinking?: NekThoughtLevel;
    mode?: NekMode;
  }): Promise<NekSessionResult> {
    this.assertAlive();
    const approval = await this.resolveProjectApproval(input.cwd);
    const key = `new:${randomUUID()}`;
    const record: NekSessionRecord = {
      key,
      sessionId: key,
      cwd: input.cwd,
      phase: "idle",
      readonly: false,
      closing: false,
    };
    this.sessions.set(key, record);
    try {
      const process = await this.openProcess(record, {
        sessionKey: key,
        cwd: input.cwd,
        approve: approval,
        extensionUi: this.extensionUiFor({ workspacePath: input.cwd, sessionKey: key }),
      });
      if (input.model || input.thinking || input.mode) {
        await this.withLease(record, async () => {
          if (input.model) await process.client.call({ type: "set_model", ...input.model });
          if (input.thinking)
            await process.client.call({ type: "set_thinking_level", level: input.thinking });
          if (input.mode) await this.setMode({ sessionKey: key, mode: input.mode });
          await this.refreshProcessSnapshot(record);
        });
      }
      return this.result(record);
    } catch (error) {
      this.removeRecord(record);
      await this.reclaimQuietly(record, "failed to reclaim a failed nek session process");
      throw error;
    }
  }

  /** 恢复会话：被外部占用时只读打开快照；否则启动进程并装载历史。 */
  async resumeSession(input: { sessionPath: string; cwd?: string }): Promise<NekSessionResult> {
    this.assertAlive();
    const existing = this.byPath.get(input.sessionPath);
    if (existing?.process && !existing.readonly) return this.result(existing);
    const control = await this.pool.ensureControl();
    const snapshot = await control.client.call({
      type: "read_session_snapshot",
      sessionPath: input.sessionPath,
    });
    if (!isNekSessionSnapshot(snapshot))
      throw new Error("nek returned an invalid session snapshot");
    if (snapshot.session.locked) return this.openLockedSnapshot(snapshot, input.cwd);

    const record =
      existing ??
      this.createRecord({
        key: input.sessionPath,
        sessionId: snapshot.session.id,
        path: input.sessionPath,
        cwd: input.cwd ?? snapshot.session.cwd,
        phase: "idle",
        readonly: false,
        closing: false,
      });
    record.readonly = false;
    record.lockedBy = undefined;
    record.snapshot = undefined;
    const approval = await this.resolveProjectApproval(record.cwd);
    await this.openProcess(record, {
      sessionKey: record.key,
      cwd: record.cwd,
      sessionPath: input.sessionPath,
      approve: approval,
      extensionUi: this.extensionUiFor({ workspacePath: record.cwd, sessionKey: record.key }),
    });
    if (record.state?.isStreaming) {
      this.emit({
        type: "resume_notice",
        session: this.publicSession(record),
        message: "正在继续上次中断的回合",
      });
      this.setPhase(record, "running");
    }
    return this.result(record);
  }

  /** 进程崩溃或会话被外部释放后重新打开同一个会话文件。 */
  async restartSession(sessionKey: string): Promise<NekSessionResult> {
    const record = this.requireRecord(sessionKey);
    if (!record.path) throw new Error("cannot restart a session without a session path");
    record.readonly = false;
    record.lockedBy = undefined;
    const approval = await this.resolveProjectApproval(record.cwd);
    await this.openProcess(record, { ...this.processRequest(record), approve: approval });
    return this.result(record);
  }

  async closeSession(sessionKey: string | { sessionKey: string }): Promise<boolean> {
    const record = this.requireRecord(
      typeof sessionKey === "string" ? sessionKey : sessionKey.sessionKey,
    );
    record.closing = true;
    this.detachProcess(record);
    await this.pool.reclaimSession(record.key, "dispose");
    this.removeRecord(record);
    return true;
  }

  async renameSession(input: {
    sessionKey?: string;
    sessionPath?: string;
    name: string;
  }): Promise<void> {
    const path = input.sessionPath ?? this.requireRecord(input.sessionKey ?? "").path;
    if (!path) throw new Error("renameSession requires sessionPath");
    const control = await this.pool.ensureControl();
    await control.client.call({ type: "rename_session", sessionPath: path, name: input.name });
  }

  async deleteSession(input: { sessionKey?: string; sessionPath?: string }): Promise<void> {
    const record = input.sessionKey ? this.resolveRecord(input.sessionKey) : undefined;
    const path = input.sessionPath ?? record?.path;
    if (!path) throw new Error("deleteSession requires sessionPath");
    const control = await this.pool.ensureControl();
    await control.client.call({ type: "delete_session", sessionPath: path });
    if (!record) return;
    record.closing = true;
    this.detachProcess(record);
    await this.pool.reclaimSession(record.key, "dispose");
    this.removeRecord(record);
  }

  /** 会话目录走控制进程：不需要为列目录启动任何会话进程。 */
  async listSessions(options: NekSessionListOptions = {}): Promise<NekSessionSummary[]> {
    const control = await this.pool.ensureControl();
    const result = await control.client.call({ type: "list_sessions", ...options });
    return result.sessions;
  }

  /** v4 订阅：立刻回放快照，然后推增量；多个订阅者共享同一个投影器与进程。 */
  async subscribeConversation(
    sessionKey: string,
    listener: NekConversationListener,
  ): Promise<() => void> {
    const record = this.requireRecord(sessionKey);
    if (!record.projector) await this.refreshProcessSnapshot(record);
    return record.projector!.subscribe(listener);
  }

  conversationSnapshot(sessionKey: string): ConversationSnapshot {
    const record = this.requireRecord(sessionKey);
    if (!record.projector) throw new Error(`conversation is not loaded for ${sessionKey}`);
    return record.projector.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.detachPoolEvents?.();
    this.detachPoolEvents = undefined;
    for (const record of this.sessions.values()) {
      record.closing = true;
      record.projector?.dispose();
      this.detachProcess(record);
    }
    this.sessions.clear();
    this.byPath.clear();
    this.interactions.dispose();
    await this.pool.dispose();
    this.listeners.clear();
  }

  private commandTarget(sessionKey: string, writable: boolean): NekAgentCommandTarget {
    const record = writable ? this.requireWritable(sessionKey) : this.requireRecord(sessionKey);
    const process = this.requireProcess(record);
    return {
      client: process.client,
      projector: record.projector,
      phase: record.phase,
      setPhase: (phase) => this.setPhase(record, phase),
    };
  }

  /** 打开失败时尽力回收进程：原始错误照原样抛出，回收失败只记账。 */
  private async reclaimQuietly(record: NekSessionRecord, message: string): Promise<void> {
    try {
      await this.pool.reclaimSession(record.key, "dispose");
    } catch (error) {
      this.logger?.warn(message, error);
    }
  }
}
