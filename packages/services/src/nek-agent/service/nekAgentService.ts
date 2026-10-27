import { randomUUID } from "node:crypto";
import { DEFAULT_GUI_RUNTIME_CONFIG, type GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekBashResult,
  NekCompactionResult,
  NekMentionTargetInfo,
  NekModel,
  NekSessionStats,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import { NekProcessPool } from "../nekProcessPool.js";
import { createNekRpcProcess, type NekRpcProcess } from "../nekRpcProcess.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type { NekAgentCommandContext, NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { nekAgentServiceCommandMethods, type NekAgentServiceCommandMethods } from "./nekAgentServiceCommandMethods.js";
import { nekAgentServiceRuntimeMethods, type NekAgentServiceRuntimeMethods } from "./nekAgentServiceRuntimeMethods.js";
import {
  isNekSessionSnapshot,
  type NekAgentServiceEvent,
  type NekAgentServiceOptions,
  type NekConversationListener,
  type NekMode,
  type NekPromptInput,
  type NekSession,
  type NekSessionListOptions,
  type NekSessionProcessCreateOptions,
  type NekSessionRecord,
  type NekSessionResult,
  type NekThoughtLevel,
} from "./types.js";

/** GUI 对 nek RPC 的唯一会话所有者；不实现 IZCodeAgentService。 */
export interface NekAgentService extends NekAgentServiceCommandMethods, NekAgentServiceRuntimeMethods {}

export class NekAgentService {
  private readonly config: GuiRuntimeConfig;
  private readonly logger: NekAgentServiceOptions["logger"];
  private readonly extensionUi: NekExtensionUiHandler | undefined;
  private readonly askProjectTrust: NekAgentServiceOptions["askProjectTrust"];
  private readonly sessions = new Map<string, NekSessionRecord>();
  private readonly byPath = new Map<string, NekSessionRecord>();
  private readonly pendingCreates = new Map<string, NekSessionProcessCreateOptions>();
  private readonly listeners = new Set<(event: NekAgentServiceEvent) => void>();
  private readonly pool: NekProcessPool<NekRpcProcess>;
  private readonly defaultCwd: string;
  private disposed = false;

  constructor(options: NekAgentServiceOptions) {
    this.config = options.runtimeConfig ?? DEFAULT_GUI_RUNTIME_CONFIG;
    this.logger = options.logger;
    this.extensionUi = options.extensionUi;
    this.askProjectTrust = options.askProjectTrust;
    this.defaultCwd = options.cwd ?? process.cwd();
    this.pool =
      options.processPool ??
      new NekProcessPool<NekRpcProcess>({
        maxSessions: this.config.nek.maxSessionProcesses,
        idleTimeoutMs: this.config.nek.idleMinutes * 60_000,
        createSessionProcess: async (sessionKey) => {
          const request = this.pendingCreates.get(sessionKey);
          if (!request) throw new Error(`no create options for nek session ${sessionKey}`);
          return await this.createSessionProcess(request, options);
        },
        createControlProcess: async () => {
          if (options.createControlProcess) return await options.createControlProcess();
          if (!options.guiInfo) throw new Error("nek guiInfo or createControlProcess is required");
          return createNekRpcProcess({
            guiInfo: options.guiInfo,
            cwd: this.defaultCwd,
            control: true,
            client: this.clientOptions(),
            logger: this.logger,
          });
        },
        logger: this.logger,
      });
  }

  onEvent(listener: (event: NekAgentServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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
      if (input.thinking) await process.client.call({ type: "set_thinking_level", level: input.thinking as never });
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
    if (!isNekSessionSnapshot(snapshot)) throw new Error("nek returned an invalid session snapshot");
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
      this.emit({ type: "resume_notice", session: this.publicSession(record), message: "正在继续上次中断的回合" });
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
    const record = this.requireRecord(typeof sessionKey === "string" ? sessionKey : sessionKey.sessionKey);
    record.closing = true;
    this.detachProcess(record);
    await this.pool.reclaimSession(record.key, "dispose");
    this.removeRecord(record);
    return true;
  }

  async renameSession(input: { sessionKey?: string; sessionPath?: string; name: string }): Promise<void> {
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


  async subscribeConversation(sessionKey: string, listener: NekConversationListener): Promise<() => void> {
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
    if (record.readonly) throw new Error(`nek session ${sessionKey} is read-only (${record.lockedBy ?? "locked"})`);
    return record;
  }

  private requireProcess(record: NekSessionRecord): NekRpcProcess {
    if (!record.process) throw new Error(`nek session ${record.key} has no live process`);
    return record.process;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("nek agent service has been disposed");
  }

  private emit(event: NekAgentServiceEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn("nek service listener threw", error);
      }
    }
  }
}

Object.assign(NekAgentService.prototype, nekAgentServiceRuntimeMethods, nekAgentServiceCommandMethods);
