import { randomUUID } from "node:crypto";
import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekAgentServiceCommandMethods } from "./nekAgentServiceCommandMethods.js";
import * as commands from "./nekAgentServiceCommands.js";
import type { NekAgentCommandContext, NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { NekAgentServiceRuntimeBase } from "./nekAgentServiceRuntimeMethods.js";
import {
  isNekSessionSnapshot,
  type NekAgentServiceOptions,
  type NekConversationListener,
  type NekMode,
  type NekSession,
  type NekSessionListOptions,
  type NekSessionRecord,
  type NekSessionResult,
} from "./types.js";

/**
 * GUI 对 nek RPC 的唯一会话所有者；不实现 `IZCodeAgentService`。
 *
 * 会话生命周期方法与命令方法都在这里对外暴露，命令实现落在 `nekAgentServiceCommands.ts`
 * （无状态的 RPC 调用），进程与投影器接线落在 `NekAgentServiceRuntimeBase`。
 */
export class NekAgentService
  extends NekAgentServiceRuntimeBase
  implements NekAgentServiceCommandMethods
{
  constructor(options: NekAgentServiceOptions) {
    super(options);
  }

  // ---- 输入 ----

  readonly sendPrompt: NekAgentServiceCommandMethods["sendPrompt"] = async (input) =>
    await commands.sendPrompt(this.commandContext(), input);

  readonly abort: NekAgentServiceCommandMethods["abort"] = async (sessionKey) =>
    await commands.abort(this.commandContext(), sessionKey);

  readonly bash: NekAgentServiceCommandMethods["bash"] = async (input) =>
    await commands.bash(this.commandContext(), input);

  readonly abortBash: NekAgentServiceCommandMethods["abortBash"] = async (sessionKey) =>
    await commands.abortBash(this.commandContext(), sessionKey);

  readonly clearQueue: NekAgentServiceCommandMethods["clearQueue"] = async (sessionKey) =>
    await commands.clearQueue(this.commandContext(), sessionKey);

  readonly retrieveQueue: NekAgentServiceCommandMethods["retrieveQueue"] = async (sessionKey) =>
    await commands.retrieveQueue(this.commandContext(), sessionKey);

  // ---- 会话操作 ----

  readonly compact: NekAgentServiceCommandMethods["compact"] = async (input) =>
    await commands.compact(this.commandContext(), input);

  readonly setModel: NekAgentServiceCommandMethods["setModel"] = async (input) =>
    await commands.setModel(this.commandContext(), input);

  readonly cycleModel: NekAgentServiceCommandMethods["cycleModel"] = async (sessionKey) =>
    await commands.cycleModel(this.commandContext(), sessionKey);

  readonly setThinkingLevel: NekAgentServiceCommandMethods["setThinkingLevel"] = async (input) =>
    await commands.setThinkingLevel(this.commandContext(), input);

  readonly setThoughtLevel: NekAgentServiceCommandMethods["setThoughtLevel"] = async (input) =>
    await commands.setThinkingLevel(this.commandContext(), input);

  readonly cycleThinkingLevel: NekAgentServiceCommandMethods["cycleThinkingLevel"] = async (
    sessionKey,
  ) => await commands.cycleThinkingLevel(this.commandContext(), sessionKey);

  readonly cycleThoughtLevel: NekAgentServiceCommandMethods["cycleThoughtLevel"] = async (
    sessionKey,
  ) => await commands.cycleThinkingLevel(this.commandContext(), sessionKey);

  readonly setMode: NekAgentServiceCommandMethods["setMode"] = async (input) =>
    await commands.setMode(this.commandContext(), input);

  readonly getStats: NekAgentServiceCommandMethods["getStats"] = async (sessionKey) =>
    await commands.getStats(this.commandContext(), sessionKey);

  readonly getCommands: NekAgentServiceCommandMethods["getCommands"] = async (sessionKey) =>
    await commands.getCommands(this.commandContext(), sessionKey);

  readonly getMentionTargets: NekAgentServiceCommandMethods["getMentionTargets"] = async (input) =>
    await commands.getMentionTargets(this.commandContext(), input);

  readonly reload: NekAgentServiceCommandMethods["reload"] = async (sessionKey) =>
    await commands.reload(this.commandContext(), sessionKey);

  // ---- 会话树与历史 ----

  readonly navigateTree: NekAgentServiceCommandMethods["navigateTree"] = async (input) =>
    await commands.navigateTree(this.commandContext(), input);

  readonly setEntryLabel: NekAgentServiceCommandMethods["setEntryLabel"] = async (input) =>
    await commands.setEntryLabel(this.commandContext(), input);

  readonly fork: NekAgentServiceCommandMethods["fork"] = async (input) =>
    await commands.fork(this.commandContext(), input);

  readonly clone: NekAgentServiceCommandMethods["clone"] = async (sessionKey) =>
    await commands.clone(this.commandContext(), sessionKey);

  // ---- 导出与导入 ----

  readonly exportSession: NekAgentServiceCommandMethods["exportSession"] = async (input) =>
    await commands.exportSession(this.commandContext(), input);

  readonly shareSession: NekAgentServiceCommandMethods["shareSession"] = async (sessionKey) =>
    await commands.shareSession(this.commandContext(), sessionKey);

  readonly importSession: NekAgentServiceCommandMethods["importSession"] = async (input) =>
    await commands.importSession(this.commandContext(), input);

  getSession(sessionKey: string): NekSession | undefined {
    const record = this.resolveRecord(sessionKey);
    return record ? this.publicSession(record) : undefined;
  }

  commandContext(): NekAgentCommandContext {
    return {
      writableTarget: (sessionKey) => this.commandTarget(sessionKey, true),
      target: (sessionKey) => this.commandTarget(sessionKey, false),
      control: async () => (await this.pool.ensureControl()).client,
    };
  }

  async createSession(input: {
    cwd: string;
    model?: { provider: string; modelId: string };
    thinking?: string;
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
      const process = await this.acquireProcess(record, {
        sessionKey: key,
        cwd: input.cwd,
        approve: approval,
        extensionUi: this.extensionUi,
      });
      await this.initializeProcess(record, process);
      if (input.model) await process.client.call({ type: "set_model", ...input.model });
      if (input.thinking)
        await process.client.call({ type: "set_thinking_level", level: input.thinking as never });
      if (input.mode) await this.setMode({ sessionKey: key, mode: input.mode });
      await this.refreshProcessSnapshot(record);
      return this.result(record);
    } catch (error) {
      this.removeRecord(record);
      throw error;
    }
  }

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
    record.snapshot = snapshot;
    const process = await this.acquireProcess(record, {
      sessionKey: record.key,
      cwd: record.cwd,
      sessionPath: input.sessionPath,
      extensionUi: this.extensionUi,
    });
    await this.initializeProcess(record, process);
    await this.refreshProcessSnapshot(record);
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

  async restartSession(sessionKey: string): Promise<NekSessionResult> {
    const record = this.requireRecord(sessionKey);
    if (!record.path) throw new Error("cannot restart a session without a session path");
    record.readonly = false;
    record.lockedBy = undefined;
    const process = await this.acquireProcess(record, {
      sessionKey: record.key,
      cwd: record.cwd,
      sessionPath: record.path,
    });
    await this.initializeProcess(record, process);
    await this.refreshProcessSnapshot(record);
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
    if (record) {
      record.closing = true;
      this.detachProcess(record);
      await this.pool.reclaimSession(record.key, "dispose");
      this.removeRecord(record);
    }
  }

  async listSessions(options: NekSessionListOptions = {}): Promise<NekSessionSummary[]> {
    const control = await this.pool.ensureControl();
    const result = await control.client.call({ type: "list_sessions", ...options });
    return result.sessions;
  }

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
    for (const record of this.sessions.values()) {
      record.closing = true;
      this.detachProcess(record);
    }
    this.sessions.clear();
    this.byPath.clear();
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

  private resolveRecord(sessionKey: string): NekSessionRecord | undefined {
    return this.sessions.get(sessionKey) ?? this.byPath.get(sessionKey);
  }

  private requireRecord(sessionKey: string): NekSessionRecord {
    const record = this.resolveRecord(sessionKey);
    if (!record) throw new Error(`unknown nek session ${sessionKey}`);
    return record;
  }

  private requireWritable(sessionKey: string): NekSessionRecord {
    const record = this.requireRecord(sessionKey);
    if (record.readonly)
      throw new Error(`nek session ${sessionKey} is read-only (${record.lockedBy ?? "locked"})`);
    return record;
  }

  private requireProcess(record: NekSessionRecord): NekRpcProcess {
    if (!record.process) throw new Error(`nek session ${record.key} has no live process`);
    return record.process;
  }
}
