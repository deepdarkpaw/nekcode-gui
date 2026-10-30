import { DEFAULT_GUI_RUNTIME_CONFIG, type GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type {
  NekAgentMessage,
  NekExtensionUiResponse,
  NekInteractionFrame,
  NekInteractionScope,
  NekRpcEvent,
  NekSessionEntry,
  NekSessionSnapshot,
} from "@zcode/shared/nek-protocol";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import type { NekRpcClientOptions, NekRpcProcessExit } from "../nekRpcClient.js";
import type { NekProcessPool, NekProcessPoolEvent } from "../nekProcessPool.js";
import { createNekRpcProcess, type NekRpcProcess } from "../nekRpcProcess.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import { NekGuiInteractionBridge } from "./guiInteractionBridge.js";
import { createProjectTrustPrompt, resolveProjectTrustApproval } from "./projectTrustPrompt.js";
import { isNekState } from "./types.js";
import {
  NEK_LONG_RUNNING_COMMANDS,
  createNekAgentProcessPool,
  createNekConversationProjector,
  nekLockLabel,
} from "./nekAgentServiceWiring.js";
import type {
  NekAgentServiceEvent,
  NekAgentServiceOptions,
  NekSession,
  NekSessionPhase,
  NekSessionProcessCreateOptions,
  NekSessionRecord,
  NekSessionResult,
} from "./types.js";

/**
 * 会话记录表、进程池接线、事件路由与投影器装载。
 *
 * 这一层只处理"一个会话记录如何挂上 nek 进程并保持状态"，不暴露对外的命令方法；
 * 对外 API 见 `NekAgentService`，命令实现见 `nekAgentServiceCommands.ts`。
 */
export abstract class NekAgentServiceRuntimeBase {
  protected readonly config: GuiRuntimeConfig;
  protected readonly logger: NekAgentServiceOptions["logger"];
  protected readonly customExtensionUi: NekExtensionUiHandler | undefined;
  protected readonly interactions: NekGuiInteractionBridge;
  protected readonly askProjectTrust: NekAgentServiceOptions["askProjectTrust"];
  protected readonly defaultCwd: string;
  protected readonly pool: NekProcessPool<NekRpcProcess>;
  protected readonly pendingCreates = new Map<string, NekSessionProcessCreateOptions>();
  protected readonly sessions = new Map<string, NekSessionRecord>();
  protected readonly byPath = new Map<string, NekSessionRecord>();
  protected readonly listeners = new Set<(event: NekAgentServiceEvent) => void>();
  protected detachPoolEvents: (() => void) | undefined;
  protected disposed = false;

  constructor(options: NekAgentServiceOptions) {
    this.config = options.runtimeConfig ?? DEFAULT_GUI_RUNTIME_CONFIG;
    this.logger = options.logger;
    this.defaultCwd = options.cwd ?? process.cwd();
    this.customExtensionUi = options.extensionUi;
    this.interactions = new NekGuiInteractionBridge({
      timeoutMs: this.config.timeouts.interactionMs,
      maxPending: this.config.events.pendingInteractions,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    this.askProjectTrust =
      options.askProjectTrust ?? createProjectTrustPrompt((scope) => this.extensionUiFor(scope));
    this.pool =
      options.processPool ??
      createNekAgentProcessPool({
        config: this.config,
        logger: this.logger,
        defaultCwd: this.defaultCwd,
        serviceOptions: options,
        pendingCreates: this.pendingCreates,
        createSessionProcess: async (request) => await this.createSessionProcess(request, options),
        clientOptions: (scope) => this.clientOptions(scope),
      });
    this.detachPoolEvents = this.pool.onEvent((event) => this.handlePoolEvent(event));
  }

  /** GUI 运行参数（只读）；适配层用它决定计划列表上限等有界值。 */
  get runtimeConfig(): GuiRuntimeConfig {
    return this.config;
  }

  onEvent(listener: (event: NekAgentServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 渲染层订阅交互帧。
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

  protected emit(event: NekAgentServiceEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn("nek service listener threw", error);
      }
    }
  }

  /** 某个范围的扩展 UI 处理器：注入的实现优先，否则走交互桥（按范围打标）。 */
  protected extensionUiFor(scope: NekInteractionScope): NekExtensionUiHandler {
    return this.customExtensionUi ?? this.interactions.scoped(scope);
  }

  protected assertAlive(): void {
    if (this.disposed) throw new Error("nek agent service has been disposed");
  }

  protected async createSessionProcess(
    request: NekSessionProcessCreateOptions,
    options: NekAgentServiceOptions,
  ): Promise<NekRpcProcess> {
    if (options.createSessionProcess) return await options.createSessionProcess(request);
    if (!options.guiInfo) throw new Error("nek guiInfo or createSessionProcess is required");
    return createNekRpcProcess({
      guiInfo: options.guiInfo,
      cwd: request.cwd,
      sessionPath: request.sessionPath,
      approve: request.approve,
      client: this.clientOptions({ workspacePath: request.cwd, sessionKey: request.sessionKey }),
      logger: this.logger,
    });
  }

  protected clientOptions(scope: NekInteractionScope): Omit<NekRpcClientOptions, "logger"> {
    const timeouts: Record<string, number> = {
      prompt: this.config.timeouts.promptPreflightMs,
      default: this.config.timeouts.commandMs,
    };
    for (const command of NEK_LONG_RUNNING_COMMANDS)
      timeouts[command] = this.config.timeouts.longRunningMs;
    return {
      defaultTimeoutMs: this.config.timeouts.commandMs,
      timeouts,
      closeGraceMs: this.config.timeouts.shutdownGraceMs,
      maxLineBytes: this.config.nek.maxLineMb * 1024 * 1024,
      stderrMaxBytes: this.config.nek.stderrBufferKb * 1024,
      extensionUi: this.extensionUiFor(scope),
    };
  }

  /**
   * 启动前确定项目信任：已记录的决定直接采用，没有记录时按 `defaultProjectTrust`
   * 或渲染层的确认结果决定；确认后立刻按 nek 的规则落盘（`set_project_trust`），
   * 下次（含终端 `/trust`）不再询问。
   */
  protected async resolveProjectApproval(cwd: string): Promise<boolean> {
    if (!this.askProjectTrust) throw new Error(`project trust decision required for ${cwd}`);
    const control = await this.pool.ensureControl();
    return await resolveProjectTrustApproval({
      client: control.client,
      askProjectTrust: this.askProjectTrust,
      cwd,
    });
  }

  protected async acquireProcess(
    record: NekSessionRecord,
    request: NekSessionProcessCreateOptions,
  ): Promise<NekRpcProcess> {
    this.pendingCreates.set(record.key, request);
    try {
      const process = await this.pool.acquireSession(record.key);
      this.attachProcess(record, process);
      return process;
    } finally {
      this.pendingCreates.delete(record.key);
    }
  }

  /**
   * 打开会话进程并装载快照。完成后释放引用：进程留在池里，空闲 `idleMinutes` 后被回收，
   * 下次使用时由 {@link ensureProcess} 按同一会话文件重连。
   */
  protected async openProcess(
    record: NekSessionRecord,
    request: NekSessionProcessCreateOptions,
  ): Promise<NekRpcProcess> {
    const process = await this.acquireProcess(record, request);
    try {
      await this.initializeProcess(record, process);
      await this.refreshProcessSnapshot(record);
    } finally {
      this.pool.releaseSession(record.key);
    }
    return process;
  }

  /** 复用现有进程（刷新引用与使用时间）；已被池回收的会话按会话文件重连。 */
  protected async ensureProcess(record: NekSessionRecord): Promise<NekRpcProcess> {
    if (record.process) return await this.acquireProcess(record, this.processRequest(record));
    if (!record.path) throw new Error(`nek session ${record.key} has no session path to reopen`);
    const approval = await this.resolveProjectApproval(record.cwd);
    const process = await this.acquireProcess(record, {
      ...this.processRequest(record),
      approve: approval,
    });
    try {
      await this.initializeProcess(record, process);
      await this.refreshProcessSnapshot(record);
    } catch (error) {
      this.pool.releaseSession(record.key);
      throw error;
    }
    return process;
  }

  /** 一次命令期间持有进程引用，命令结束（含失败）后立刻归还。 */
  protected async withLease<T>(record: NekSessionRecord, run: () => Promise<T>): Promise<T> {
    await this.ensureProcess(record);
    try {
      return await run();
    } finally {
      this.pool.releaseSession(record.key);
    }
  }

  /** 会话级命令入口：先定位记录，只读会话不建进程（写命令由命令层拒绝）。 */
  protected async withSession<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    const record = this.requireRecord(sessionKey);
    if (record.readonly) return await run();
    return await this.withLease(record, run);
  }

  protected attachProcess(record: NekSessionRecord, process: NekRpcProcess): void {
    if (record.process === process) return;
    this.detachProcess(record);
    record.process = process;
    record.readonly = false;
    record.detachEvents = process.client.onAnyEvent((event) => this.handleEvent(record, event));
    record.detachExit = process.client.onExit((exit) => this.handleProcessExit(record, exit));
  }

  protected detachProcess(record: NekSessionRecord): void {
    record.detachEvents?.();
    record.detachEvents = undefined;
    record.detachExit?.();
    record.detachExit = undefined;
    record.process = undefined;
  }

  protected async initializeProcess(
    record: NekSessionRecord,
    process: NekRpcProcess,
  ): Promise<void> {
    const state = await process.client.call({ type: "get_state" });
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    if (record.path) this.byPath.set(record.path, record);
    if (state.isStreaming) this.setPhase(record, "running");
  }

  /** 用 get_entries / get_state / get_session_stats 重建投影器快照。 */
  protected async refreshProcessSnapshot(record: NekSessionRecord): Promise<void> {
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
  }

  protected createProjector(record: NekSessionRecord): NekConversationProjector {
    return createNekConversationProjector({ config: this.config, logger: this.logger, record });
  }

  /**
   * 会话被外部进程占用时只读打开：不启动进程，只把快照装进投影器。
   *
   * nek 从 P2c 起在快照里报出锁持有者（`lockedBy`），这里原样透传给会话记录和
   * `NekSession.lockHolder`；更早的 nek 只报 `locked: true`，此时占用者仍记为 `"nek"`。
   */
  protected openLockedSnapshot(snapshot: NekSessionSnapshot, cwd?: string): NekSessionResult {
    const existing = this.byPath.get(snapshot.session.path);
    if (existing) this.removeRecord(existing);
    const holder = snapshot.lockedBy;
    const record = this.createRecord({
      key: snapshot.session.path,
      sessionId: snapshot.session.id,
      path: snapshot.session.path,
      cwd: cwd ?? snapshot.session.cwd,
      phase: "locked",
      readonly: true,
      lockedBy: nekLockLabel(holder),
      ...(holder ? { lockHolder: holder } : {}),
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
  }

  protected handleEvent(record: NekSessionRecord, event: NekRpcEvent): void {
    record.projector?.handleEvent(event);
    this.emit({ type: "rpc_event", session: this.publicSession(record), event });
    switch (event.type) {
      case "agent_start":
        this.pool.beginTurn(record.key);
        this.setPhase(record, "running");
        break;
      case "agent_settled":
        this.pool.endTurn(record.key);
        this.setPhase(record, "idle");
        void this.refreshProcessSnapshot(record).catch((error) => {
          this.logger?.warn("failed to refresh nek snapshot after agent_settled", error);
        });
        break;
      case "extension_ui_request":
        if (
          event.method === "structured" ||
          ["select", "confirm", "input", "editor"].includes(event.method)
        )
          this.setPhase(record, "waiting_input");
        break;
      case "extension_ui_cancel":
        if (record.phase === "waiting_input")
          this.setPhase(record, record.state?.isStreaming ? "running" : "idle");
        break;
      case "extension_error":
        this.setPhase(record, "error");
        break;
      default:
        break;
    }
  }

  protected handleProcessExit(record: NekSessionRecord, exit: NekRpcProcessExit): void {
    if (record.closing || this.disposed) return;
    this.detachProcess(record);
    this.interactions.cancelScope({ workspacePath: record.cwd, sessionKey: record.key });
    this.setPhase(record, "error");
    this.emit({ type: "process_exit", session: this.publicSession(record), exit });
  }

  protected setPhase(record: NekSessionRecord, phase: NekSessionPhase): void {
    if (record.phase === phase) return;
    const previous = record.phase;
    record.phase = phase;
    this.emit({ type: "state", session: this.publicSession(record), previous, state: phase });
  }

  /** 会话键或会话路径都能定位记录。 */
  protected resolveRecord(sessionKey: string): NekSessionRecord | undefined {
    return this.sessions.get(sessionKey) ?? this.byPath.get(sessionKey);
  }

  protected requireRecord(sessionKey: string): NekSessionRecord {
    const record = this.resolveRecord(sessionKey);
    if (!record) throw new Error(`unknown nek session ${sessionKey}`);
    return record;
  }

  protected requireWritable(sessionKey: string): NekSessionRecord {
    const record = this.requireRecord(sessionKey);
    if (record.readonly)
      throw new Error(`nek session ${sessionKey} is read-only (${record.lockedBy ?? "locked"})`);
    return record;
  }

  protected requireProcess(record: NekSessionRecord): NekRpcProcess {
    if (!record.process) throw new Error(`nek session ${record.key} has no live process`);
    return record.process;
  }

  protected processRequest(record: NekSessionRecord): NekSessionProcessCreateOptions {
    return {
      sessionKey: record.key,
      cwd: record.cwd,
      ...(record.path ? { sessionPath: record.path } : {}),
      extensionUi: this.extensionUiFor({
        workspacePath: record.cwd,
        sessionKey: record.key,
        sessionId: record.sessionId,
      }),
    };
  }

  /** 池回收空闲/容量牺牲的进程不是崩溃：静默断开，下次使用时重连。 */
  protected handlePoolEvent(event: NekProcessPoolEvent): void {
    if (event.type !== "session_reclaimed") return;
    if (event.reason === "dispose" || event.reason === "crashed") return;
    const record = this.sessions.get(event.sessionKey);
    if (!record) return;
    this.detachProcess(record);
    this.setPhase(record, "idle");
  }

  protected publicSession(record: NekSessionRecord): NekSession {
    return {
      sessionKey: record.key,
      sessionId: record.sessionId,
      ...(record.path ? { sessionPath: record.path } : {}),
      cwd: record.cwd,
      phase: record.phase,
      readonly: record.readonly,
      ...(record.lockedBy ? { lockedBy: record.lockedBy } : {}),
      ...(record.lockHolder ? { lockHolder: record.lockHolder } : {}),
      ...(record.process?.pid ? { processId: record.process.pid } : {}),
      ...(record.snapshot ? { snapshot: record.snapshot } : {}),
    };
  }

  protected createRecord(record: NekSessionRecord): NekSessionRecord {
    this.sessions.set(record.key, record);
    if (record.path) this.byPath.set(record.path, record);
    return record;
  }

  protected removeRecord(record: NekSessionRecord): void {
    this.sessions.delete(record.key);
    if (record.path && this.byPath.get(record.path) === record) this.byPath.delete(record.path);
    this.interactions.cancelScope({ workspacePath: record.cwd, sessionKey: record.key });
    record.projector?.dispose();
    this.detachProcess(record);
  }

  protected result(record: NekSessionRecord): NekSessionResult {
    if (!record.projector) throw new Error(`conversation is not loaded for ${record.key}`);
    return { ...this.publicSession(record), conversation: record.projector.snapshot() };
  }
}
