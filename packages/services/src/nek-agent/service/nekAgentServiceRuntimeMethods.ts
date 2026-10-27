import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekGuiInfo,
  NekRpcEvent,
  NekRpcSessionState,
  NekSessionEntry,
  NekSessionSnapshot,
  NekState,
} from "@zcode/shared/nek-protocol";
import type { GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import { NekConversationProjector } from "../nekConversationProjector.js";
import type { NekProcessPool } from "../nekProcessPool.js";
import { createNekRpcProcess, type NekRpcProcess } from "../nekRpcProcess.js";
import type { NekRpcClientOptions, NekRpcProcessExit } from "../nekRpcClient.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type {
  NekAgentServiceEvent,
  NekAgentServiceOptions,
  NekSession,
  NekSessionProcessCreateOptions,
  NekSessionRecord,
  NekSessionPhase,
  NekSessionResult,
} from "./types.js";
import { isNekState, type NekMode } from "./types.js";

const LONG_RUNNING_COMMANDS = [
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

export interface NekAgentServiceRuntimeHost {
  config: GuiRuntimeConfig;
  logger: NekAgentServiceOptions["logger"];
  extensionUi: NekExtensionUiHandler | undefined;
  askProjectTrust: NekAgentServiceOptions["askProjectTrust"];
  defaultCwd: string;
  pool: NekProcessPool<NekRpcProcess>;
  pendingCreates: Map<string, NekSessionProcessCreateOptions>;
  sessions: Map<string, NekSessionRecord>;
  byPath: Map<string, NekSessionRecord>;
  disposed: boolean;
  emit(event: NekAgentServiceEvent): void;
  setPhase(record: NekSessionRecord, phase: NekSessionPhase): void;
  publicSession(record: NekSessionRecord): NekSession;
  clientOptions(): Omit<NekRpcClientOptions, "logger">;
  attachProcess(record: NekSessionRecord, process: NekRpcProcess): void;
  detachProcess(record: NekSessionRecord): void;
  handleEvent(record: NekSessionRecord, event: NekRpcEvent): void;
  handleProcessExit(record: NekSessionRecord, exit: NekRpcProcessExit): void;
  createProjector(record: NekSessionRecord): NekConversationProjector;
  removeRecord(record: NekSessionRecord): void;
  createRecord(record: NekSessionRecord): NekSessionRecord;
  result(record: NekSessionRecord): NekSessionResult;
}

export interface NekAgentServiceRuntimeMethods {
  createSessionProcess(request: NekSessionProcessCreateOptions, options: NekAgentServiceOptions): Promise<NekRpcProcess>;
  clientOptions(): Omit<NekRpcClientOptions, "logger">;
  resolveProjectApproval(cwd: string): Promise<boolean>;
  acquireProcess(record: NekSessionRecord, request: NekSessionProcessCreateOptions): Promise<NekRpcProcess>;
  attachProcess(record: NekSessionRecord, process: NekRpcProcess): void;
  detachProcess(record: NekSessionRecord): void;
  initializeProcess(record: NekSessionRecord, process: NekRpcProcess): Promise<void>;
  refreshProcessSnapshot(record: NekSessionRecord): Promise<void>;
  createProjector(record: NekSessionRecord): NekConversationProjector;
  openLockedSnapshot(snapshot: NekSessionSnapshot, cwd?: string): NekSessionResult;
  handleEvent(record: NekSessionRecord, event: NekRpcEvent): void;
  handleProcessExit(record: NekSessionRecord, exit: NekRpcProcessExit): void;
  createRecord(record: NekSessionRecord): NekSessionRecord;
  removeRecord(record: NekSessionRecord): void;
  result(record: NekSessionRecord): NekSessionResult;
  setPhase(record: NekSessionRecord, phase: NekSessionPhase): void;
  publicSession(record: NekSessionRecord): NekSession;
}

export const nekAgentServiceRuntimeMethods: NekAgentServiceRuntimeMethods = {
  async createSessionProcess(this: NekAgentServiceRuntimeHost, request, options) {
    if (options.createSessionProcess) return await options.createSessionProcess(request);
    if (!options.guiInfo) throw new Error("nek guiInfo or createSessionProcess is required");
    return createNekRpcProcess({
      guiInfo: options.guiInfo,
      cwd: request.cwd,
      sessionPath: request.sessionPath,
      approve: request.approve,
      client: this.clientOptions(),
      logger: this.logger,
    });
  },

  clientOptions(this: NekAgentServiceRuntimeHost) {
    const timeouts: Record<string, number> = {
      prompt: this.config.timeouts.promptPreflightMs,
      default: this.config.timeouts.commandMs,
    };
    for (const command of LONG_RUNNING_COMMANDS) timeouts[command] = this.config.timeouts.longRunningMs;
    return {
      defaultTimeoutMs: this.config.timeouts.commandMs,
      timeouts,
      closeGraceMs: this.config.timeouts.shutdownGraceMs,
      maxLineBytes: this.config.nek.maxLineMb * 1024 * 1024,
      stderrMaxBytes: this.config.nek.stderrBufferKb * 1024,
      extensionUi: this.extensionUi,
    };
  },

  async resolveProjectApproval(this: NekAgentServiceRuntimeHost, cwd) {
    const control = await this.pool.ensureControl();
    const trust = await control.client.call({ type: "get_project_trust", cwd });
    if (trust.trusted !== null) return trust.trusted;
    if (trust.defaultProjectTrust === "always") return true;
    if (trust.defaultProjectTrust === "never") return false;
    if (!this.askProjectTrust) throw new Error(`project trust decision required for ${cwd}`);
    return await this.askProjectTrust({ trust, cwd });
  },

  async acquireProcess(this: NekAgentServiceRuntimeHost, record, request) {
    this.pendingCreates.set(record.key, request);
    try {
      const process = await this.pool.acquireSession(record.key);
      this.attachProcess(record, process);
      return process;
    } finally {
      this.pendingCreates.delete(record.key);
    }
  },

  attachProcess(this: NekAgentServiceRuntimeHost, record, process) {
    if (record.process === process) return;
    this.detachProcess(record);
    record.process = process;
    record.readonly = false;
    record.detachEvents = process.client.onAnyEvent((event) => this.handleEvent(record, event));
    record.detachExit = process.client.onExit((exit) => this.handleProcessExit(record, exit));
  },

  detachProcess(record) {
    record.detachEvents?.();
    record.detachEvents = undefined;
    record.detachExit?.();
    record.detachExit = undefined;
    record.process = undefined;
  },

  async initializeProcess(this: NekAgentServiceRuntimeHost, record, process) {
    const state = await process.client.call({ type: "get_state" });
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    if (record.path) this.byPath.set(record.path, record);
    if (state.isStreaming) this.setPhase(record, "running");
  },

  async refreshProcessSnapshot(this: NekAgentServiceRuntimeHost, record) {
    const process = record.process;
    if (!process) throw new Error(`nek session ${record.key} has no live process`);
    const [state, entries, stats, extension] = await Promise.all([
      process.client.call({ type: "get_state" }),
      process.client.call({ type: "get_entries" }),
      process.client.call({ type: "get_session_stats" }),
      process.client.call({ type: "extension_call", method: "nek.get_state" }),
    ]);
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    if (record.path) this.byPath.set(record.path, record);
    const nekState = isNekState(extension.result) ? extension.result : undefined;
    const projector = (record.projector ??= this.createProjector(record));
    projector.loadSnapshot({
      entries: entries.entries,
      leafId: entries.leafId,
      state,
      stats,
      nekState,
      title: state.sessionName,
    });
    projector.flushNow();
    this.setPhase(record, state.isStreaming ? "running" : "idle");
  },

  createProjector(this: NekAgentServiceRuntimeHost, record) {
    return new NekConversationProjector({
      sessionId: record.sessionId,
      streamFlushIntervalMs: Math.max(1, Math.floor(1000 / this.config.events.streamFlushPerSecond)),
      maxWindowRows: this.config.events.eventBufferEntries,
      logger: this.logger,
    });
  },

  openLockedSnapshot(this: NekAgentServiceRuntimeHost, snapshot, cwd) {
    const existing = this.byPath.get(snapshot.session.path);
    if (existing) this.removeRecord(existing);
    const record = this.createRecord({
      key: snapshot.session.path,
      sessionId: snapshot.session.id,
      path: snapshot.session.path,
      cwd: cwd ?? snapshot.session.cwd,
      phase: "locked",
      readonly: true,
      lockedBy: "nek",
      snapshot,
      closing: false,
    });
    record.projector = this.createProjector(record);
    record.projector.loadSnapshot({
      entries: snapshot.entries as NekSessionEntry[],
      messages: snapshot.messages as NekAgentMessage[],
      leafId: snapshot.leafId,
      title: snapshot.session.name,
    });
    return this.result(record);
  },

  handleEvent(this: NekAgentServiceRuntimeHost, record, event) {
    record.projector?.handleEvent(event);
    switch (event.type) {
      case "agent_start":
        this.setPhase(record, "running");
        break;
      case "agent_settled":
        this.setPhase(record, "idle");
        break;
      case "extension_ui_request":
        if (event.method === "structured" || ["select", "confirm", "input", "editor"].includes(event.method))
          this.setPhase(record, "waiting_input");
        break;
      case "extension_ui_cancel":
        if (record.phase === "waiting_input") this.setPhase(record, record.state?.isStreaming ? "running" : "idle");
        break;
      case "extension_error":
        this.setPhase(record, "error");
        break;
      default:
        break;
    }
  },

  handleProcessExit(this: NekAgentServiceRuntimeHost, record, exit) {
    if (record.closing || this.disposed) return;
    this.detachProcess(record);
    this.setPhase(record, "error");
    this.emit({ type: "process_exit", session: this.publicSession(record), exit });
  },

  setPhase(this: NekAgentServiceRuntimeHost, record, phase) {
    if (record.phase === phase) return;
    const previous = record.phase;
    record.phase = phase;
    this.emit({ type: "state", session: this.publicSession(record), previous, state: phase });
  },

  publicSession(record) {
    return {
      sessionKey: record.key,
      sessionId: record.sessionId,
      ...(record.path ? { sessionPath: record.path } : {}),
      cwd: record.cwd,
      phase: record.phase,
      readonly: record.readonly,
      ...(record.lockedBy ? { lockedBy: record.lockedBy } : {}),
      ...(record.process?.pid ? { processId: record.process.pid } : {}),
      ...(record.snapshot ? { snapshot: record.snapshot } : {}),
    };
  },

  createRecord(this: NekAgentServiceRuntimeHost, record) {
    this.sessions.set(record.key, record);
    if (record.path) this.byPath.set(record.path, record);
    return record;
  },

  removeRecord(this: NekAgentServiceRuntimeHost, record) {
    this.sessions.delete(record.key);
    if (record.path && this.byPath.get(record.path) === record) this.byPath.delete(record.path);
    record.projector?.dispose();
    this.detachProcess(record);
  },

  result(this: NekAgentServiceRuntimeHost, record) {
    if (!record.projector) throw new Error(`conversation is not loaded for ${record.key}`);
    return { ...this.publicSession(record), conversation: record.projector.snapshot() };
  },
};
