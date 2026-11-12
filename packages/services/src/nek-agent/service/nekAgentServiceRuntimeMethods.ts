import { DEFAULT_GUI_RUNTIME_CONFIG, type GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type { ConversationOpenTiming } from "@zcode/shared/zcode-protocol-v4";
import { measureNekOpenBootstrap, measureNekOpenRequest } from "./nekSessionOpenTiming.js";
import type {
  NekAgentMessage,
  NekInteractionScope,
  NekRpcEvent,
  NekSessionEntry,
  NekSessionSnapshot,
} from "@zcode/shared/nek-protocol";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import type { NekRpcClientOptions, NekRpcProcessExit } from "../nekRpcClient.js";
import type { NekProcessPool, NekProcessPoolEvent } from "../nekProcessPool.js";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import { NekGuiInteractionBridge } from "./guiInteractionBridge.js";
import { createProjectTrustPrompt, requestProjectApproval } from "./projectTrustPrompt.js";
import { bindNekSessionModelRuntime, detachNekSessionProcess } from "./nekSessionModelRuntime.js";
import { applyNekPoolReclaim, applyNekSessionEvent } from "./nekSessionEventRouting.js";
import {
  bumpStateEpoch,
  initializeSessionState,
  reloadSessionSnapshot,
  type NekSessionSnapshotContext,
} from "./nekSessionSnapshotLoader.js";
import {
  NekPendingInputCancelledError,
  NekPendingInputController,
} from "./nekPendingInputQueue.js";
import {
  buildNekClientOptions,
  createNekAgentProcessPool,
  createNekConversationProjector,
  launchNekSessionProcess,
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
  /** 信任确认是否只能走渲染层交互通道（注入回调或自定义 handler 时不是）。 */
  protected readonly trustThroughInteractions: boolean;
  protected readonly defaultCwd: string;
  protected readonly pool: NekProcessPool<NekRpcProcess>;
  protected readonly pendingCreates = new Map<string, NekSessionProcessCreateOptions>();
  /** 压缩期间 GUI 暂存的待发送输入：本层是唯一 owner。 */
  protected readonly pendingInputs: NekPendingInputController;
  protected readonly sessions = new Map<string, NekSessionRecord>();
  protected readonly byPath = new Map<string, NekSessionRecord>();
  protected readonly listeners = new Set<(event: NekAgentServiceEvent) => void>();
  protected detachPoolEvents: (() => void) | undefined;
  protected disposed = false;
  protected readonly modelFreshness: NekAgentServiceOptions["modelRuntime"];

  constructor(options: NekAgentServiceOptions) {
    this.config = options.runtimeConfig ?? DEFAULT_GUI_RUNTIME_CONFIG;
    this.modelFreshness = options.modelRuntime;
    this.logger = options.logger;
    this.pendingInputs = new NekPendingInputController({
      maxPerSession: this.config.nek.pendingInputsPerSession,
      timeoutMs: this.config.timeouts.pendingInputMs,
      withLease: async (record, run) => await this.withLease(record, run),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.defaultCwd = options.cwd ?? process.cwd();
    this.customExtensionUi = options.extensionUi;
    this.interactions = new NekGuiInteractionBridge({
      timeoutMs: this.config.timeouts.interactionMs,
      maxPending: this.config.events.pendingInteractions,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    this.trustThroughInteractions = !options.askProjectTrust && !options.extensionUi;
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
    return await launchNekSessionProcess({
      options,
      request,
      clientOptions: this.clientOptions({
        workspacePath: request.cwd,
        sessionKey: request.sessionKey,
      }),
      logger: this.logger,
    });
  }

  protected clientOptions(scope: NekInteractionScope): Omit<NekRpcClientOptions, "logger"> {
    return buildNekClientOptions({
      config: this.config,
      scope,
      extensionUi: this.extensionUiFor(scope),
    });
  }

  protected async resolveProjectApproval(cwd: string): Promise<boolean> {
    return await requestProjectApproval({
      cwd,
      askProjectTrust: this.askProjectTrust,
      ensureControl: async () => await this.pool.ensureControl(),
      assertCanAsk: () => this.assertInteractionChannel(cwd),
    });
  }

  /** 信任确认只能走渲染层时，没有订阅者就是接线问题，不能当成"用户拒绝"。 */
  private assertInteractionChannel(cwd: string): void {
    if (!this.trustThroughInteractions || this.interactions.hasSubscribers()) return;
    throw new Error(
      `project trust decision required for ${cwd}, but no renderer is subscribed to the nek interaction channel`,
    );
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
    openTiming?: ConversationOpenTiming,
  ): Promise<NekRpcProcess> {
    const process = await measureNekOpenBootstrap(openTiming, record.process, () =>
      this.acquireProcess(record, request),
    );
    try {
      await this.initializeProcess(record, process, openTiming);
      await this.refreshProcessSnapshot(record, openTiming);
      bindNekSessionModelRuntime(record, process, this.modelFreshness);
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
      bindNekSessionModelRuntime(record, process, this.modelFreshness);
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

  /** 快照装载需要的上下文：投影器工厂、phase、待发输入收口与路径索引。 */
  private snapshotContext(record: NekSessionRecord): NekSessionSnapshotContext {
    return {
      record,
      createProjector: (target) => this.createProjector(target),
      setPhase: (target, phase) => this.setPhase(target, phase),
      settlePendingInputs: (target) => this.pendingInputs.settle(target),
      bindPath: (target) => {
        if (target.path) this.byPath.set(target.path, target);
      },
      ...(this.logger ? { logger: this.logger } : {}),
    };
  }

  protected attachProcess(record: NekSessionRecord, process: NekRpcProcess): void {
    if (record.process === process) return;
    this.detachProcess(record);
    record.process = process;
    record.readonly = false;
    record.detachEvents = process.client.onAnyEvent((event) => this.handleEvent(record, event));
    record.detachExit = process.client.onExit((exit) => this.handleProcessExit(record, exit));
    // 进程可用性升级为公开事实：workspace runtime 生命周期与 sessions-index 都只认这一条
    // 信号，不再从 phase 抖动反推。
    this.emit({ type: "process_attached", session: this.publicSession(record) });
  }

  /**
   * 该 workspace 是否还有挂接进程的会话——workspace runtime 是否存活的唯一权威事实。
   *
   * 崩溃后记录仍留在表里（phase 变成 error），正常关闭则整条移除，空闲/容量回收只摘进程；
   * 只有 `record.process` 能同时覆盖这三种情况。任何在订阅方另存的"存活集合"都会在
   * 正常关闭或回收之后漂移，于是把 workspace 永久判成不可用。
   */
  hasLiveSessionProcess(cwd: string): boolean {
    return Array.from(this.sessions.values()).some(
      (record) => record.cwd === cwd && record.process !== undefined,
    );
  }

  protected detachProcess(record: NekSessionRecord): void {
    detachNekSessionProcess(record);
  }

  protected async initializeProcess(
    record: NekSessionRecord,
    process: NekRpcProcess,
    openTiming?: ConversationOpenTiming,
  ): Promise<void> {
    await measureNekOpenRequest(openTiming, () =>
      initializeSessionState(this.snapshotContext(record), process),
    );
  }

  /** 用 get_entries / get_state / get_session_stats 重建投影器快照（带生命周期世代 fence）。 */
  protected async refreshProcessSnapshot(
    record: NekSessionRecord,
    openTiming?: ConversationOpenTiming,
  ): Promise<void> {
    const process = record.process;
    if (!process) throw new Error(`nek session ${record.key} has no live process`);
    await reloadSessionSnapshot(this.snapshotContext(record), process, openTiming);
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
    record.projector.applyReadOnly({ reason: "locked", ...(holder ? { holder } : {}) });
    return this.result(record);
  }

  protected handleEvent(record: NekSessionRecord, event: NekRpcEvent): void {
    // 顺序固定：先状态机、再投影、最后广播；快照重建读的是同一份 record.state。
    applyNekSessionEvent(
      {
        record,
        bumpStateEpoch: (target) => bumpStateEpoch(target),
        setPhase: (target, phase) => this.setPhase(target, phase),
        beginTurn: (sessionKey) => this.pool.beginTurn(sessionKey),
        endTurn: (sessionKey) => this.pool.endTurn(sessionKey),
        settlePendingInputs: (target) => this.pendingInputs.settle(target),
        cancelPendingInputs: (target, reason) => this.pendingInputs.cancel(target, reason),
        refreshSnapshot: (target) =>
          void this.refreshProcessSnapshot(target).catch((error) => {
            this.logger?.warn("failed to refresh nek snapshot after agent_settled", error);
          }),
      },
      event,
    );
    record.projector?.handleEvent(event);
    this.emit({ type: "rpc_event", session: this.publicSession(record), event });
  }

  protected handleProcessExit(record: NekSessionRecord, exit: NekRpcProcessExit): void {
    if (record.closing || this.disposed) return;
    // 断线后待发送输入既不能静默丢，也不能等重连后补发：可见失败，草稿由界面恢复。
    this.pendingInputs.cancel(
      record,
      new NekPendingInputCancelledError("nek 进程已断开，消息没有发送；草稿已保留，可重试"),
    );
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
    applyNekPoolReclaim({
      event,
      record: event.type === "session_reclaimed" ? this.sessions.get(event.sessionKey) : undefined,
      detachProcess: (record) => this.detachProcess(record),
      setPhase: (record, phase) => this.setPhase(record, phase),
      cancelPendingInputs: (record, reason) => this.pendingInputs.cancel(record, reason),
    });
  }

  protected publicSession(record: NekSessionRecord): NekSession {
    return {
      sessionKey: record.key,
      sessionId: record.sessionId,
      ...(record.path ? { sessionPath: record.path } : {}),
      cwd: record.cwd,
      phase: record.phase,
      readonly: record.readonly,
      ...(this.pendingInputs.isCompacting(record) ? { isCompacting: true } : {}),
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
    this.pendingInputs.cancel(
      record,
      new NekPendingInputCancelledError("会话已关闭，消息没有发送；草稿已保留，可重试"),
    );
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
