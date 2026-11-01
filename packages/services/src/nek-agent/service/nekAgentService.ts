import { randomUUID } from "node:crypto";
import type {
  NekExtensionUiResponse,
  NekInteractionFrame,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentServiceCommandMethods as Methods } from "./nekAgentServiceCommandMethods.js";
import * as commands from "./nekAgentServiceCommands.js";
import type { NekAgentCommandContext, NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { NekAgentSessionResumeBase } from "./nekAgentSessionResume.js";
import { deleteUnusedCreatedSessions } from "./nekUnusedSessionCleanup.js";

import {
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
export class NekAgentService extends NekAgentSessionResumeBase implements Methods {
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

  /** renderer workspace 订阅全部释放时，立即取消该 workspace 的阻塞请求。 */
  cancelWorkspaceInteractions(workspacePath: string): void {
    this.interactions.cancelWorkspace(workspacePath);
  }

  /** 一次命令 = 一次会话租约：按 `input.sessionKey` 持进程引用，结束即归还给进程池。 */
  private forInput<I extends { sessionKey: string }, R>(
    run: (context: NekAgentCommandContext, input: I) => Promise<R>,
  ): (input: I) => Promise<R> {
    return async (input) =>
      await this.withSession(input.sessionKey, async () => await run(this.commandContext(), input));
  }

  /** 同 {@link forInput}，命令参数就是 sessionKey。 */
  private forKey<R>(
    run: (context: NekAgentCommandContext, sessionKey: string) => Promise<R>,
  ): (sessionKey: string) => Promise<R> {
    return async (sessionKey) =>
      await this.withSession(sessionKey, async () => await run(this.commandContext(), sessionKey));
  }

  // ---- 输入 ----
  readonly sendPrompt: Methods["sendPrompt"] = this.forInput(commands.sendPrompt);
  readonly abort: Methods["abort"] = this.forKey(commands.abort);
  readonly bash: Methods["bash"] = this.forInput(commands.bash);
  readonly abortBash: Methods["abortBash"] = this.forKey(commands.abortBash);
  readonly clearQueue: Methods["clearQueue"] = this.forKey(commands.clearQueue);
  readonly retrieveQueue: Methods["retrieveQueue"] = this.forKey(commands.retrieveQueue);

  // ---- 会话操作 ----
  readonly compact: Methods["compact"] = this.forInput(commands.compact);
  readonly setModel: Methods["setModel"] = this.forInput(commands.setModel);
  readonly cycleModel: Methods["cycleModel"] = this.forKey(commands.cycleModel);
  readonly setThinkingLevel: Methods["setThinkingLevel"] = this.forInput(commands.setThinkingLevel);
  readonly setThoughtLevel: Methods["setThoughtLevel"] = this.forInput(commands.setThinkingLevel);
  readonly cycleThinkingLevel: Methods["cycleThinkingLevel"] = this.forKey(
    commands.cycleThinkingLevel,
  );
  readonly cycleThoughtLevel: Methods["cycleThoughtLevel"] = this.forKey(
    commands.cycleThinkingLevel,
  );
  readonly setMode: Methods["setMode"] = this.forInput(commands.setMode);
  readonly getStats: Methods["getStats"] = this.forKey(commands.getStats);

  /**
   * 外部命令实现（状态 feed 等）复用的会话租约入口：取记录、持进程引用、交还命令层。
   *
   * 适配器层不直接调用 protected 的 `withSession`；这里把"一次命令 = 一次租约"的规则
   * 收口到服务内部，空闲进程因此仍可被进程池回收。
   */
  runSessionCommand<T>(sessionKey: string, run: commands.NekAgentCommandRunner<T>): Promise<T> {
    return this.withSession(sessionKey, async () => await run(this.commandContext()));
  }

  readonly getCommands: Methods["getCommands"] = this.forKey(commands.getCommands);
  readonly getEntries: Methods["getEntries"] = this.forInput(commands.getEntries);
  readonly getTree: Methods["getTree"] = this.forKey(commands.getTree);
  readonly getForkMessages: Methods["getForkMessages"] = this.forKey(commands.getForkMessages);

  /** 有会话时问会话进程，只有 cwd 时问控制进程（不占会话进程）。 */
  readonly getMentionTargets: Methods["getMentionTargets"] = async (input) => {
    const sessionKey = typeof input === "string" ? input : input.sessionKey;
    if (!sessionKey) return await commands.getMentionTargets(this.commandContext(), input);
    return await this.withSession(
      sessionKey,
      async () => await commands.getMentionTargets(this.commandContext(), input),
    );
  };

  readonly reload: Methods["reload"] = this.forKey(commands.reload);
  readonly stopSubagent: Methods["stopSubagent"] = this.forInput(commands.stopSubagent);
  readonly getSubagentTranscript: Methods["getSubagentTranscript"] = this.forInput(
    commands.getSubagentTranscript,
  );
  readonly listAgentTypes: Methods["listAgentTypes"] = this.forKey(commands.listAgentTypes);

  // ---- 会话树与历史 ----
  readonly navigateTree: Methods["navigateTree"] = this.forInput(commands.navigateTree);
  readonly setEntryLabel: Methods["setEntryLabel"] = this.forInput(commands.setEntryLabel);
  readonly fork: Methods["fork"] = this.forInput(commands.fork);
  readonly clone: Methods["clone"] = this.forKey(commands.clone);

  // ---- 导出与导入 ----
  readonly exportSession: Methods["exportSession"] = this.forInput(commands.exportSession);
  readonly shareSession: Methods["shareSession"] = this.forKey(commands.shareSession);

  /** 导入只看会话文件与目标 cwd，不依赖已打开的会话进程。 */
  readonly importSession: Methods["importSession"] = async (input) =>
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
      createdThisRun: true,
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

  /** 先关闭持锁的会话进程再删文件：nek 拒绝删除被活进程锁住的会话。 */
  async deleteSession(input: { sessionKey?: string; sessionPath?: string }): Promise<void> {
    const record = input.sessionKey ? this.resolveRecord(input.sessionKey) : undefined;
    const path = input.sessionPath ?? record?.path;
    if (!path) throw new Error("deleteSession requires sessionPath");
    if (record) await this.closeSession(record.key);
    const control = await this.pool.ensureControl();
    await control.client.call({ type: "delete_session", sessionPath: path });
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
    await deleteUnusedCreatedSessions([...this.sessions.values()], {
      deleteSession: async (input) => await this.deleteSession(input),
      ...(this.logger ? { logger: this.logger } : {}),
    });
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
}
