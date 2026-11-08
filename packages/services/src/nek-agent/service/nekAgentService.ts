import { randomUUID } from "node:crypto";
import type {
  NekExtensionUiResponse,
  NekInteractionFrame,
  NekImageContent,
  NekStoredAttachment,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentServiceCommandMethods as Methods } from "./nekAgentServiceCommandMethods.js";
import * as commands from "./nekAgentServiceCommands.js";
import type { NekAgentCommandContext, NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { NekAgentSessionResumeBase } from "./nekAgentSessionResume.js";
import { deleteUnusedCreatedSessions } from "./nekUnusedSessionCleanup.js";
import { NekPendingInputCancelledError } from "./nekPendingInputQueue.js";
import { findNekUserImage, parseNekUserImageRef } from "../projection/nekUserImages.js";
import { findNekUserFile } from "../projection/nekUserFiles.js";
import { resolveNekSessionAttachment } from "./nekSessionAttachments.js";

/** 用户图片缓存上限（base64 字符数，约 24 MB 原始字节）。 */
const USER_IMAGE_CACHE_MAX_CHARS = 32 * 1024 * 1024;

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
  /** 当前工作区仍待处理的审批，供交互订阅重放。 */
  pendingInteractions(workspacePath: string): NekInteractionFrame[] {
    return this.interactions.pendingFrames(workspacePath);
  }

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
    invalidates?: "index" | "config",
  ): (input: I) => Promise<R> {
    return async (input) =>
      await this.withSession(input.sessionKey, async () => {
        const cwd = this.requireRecord(input.sessionKey).cwd;
        const result = await run(this.commandContext(), input);
        if (invalidates) this.emit({ type: "catalog_changed", topic: invalidates, cwd });
        return result;
      });
  }

  /** 同 {@link forInput}，命令参数就是 sessionKey。 */
  private forKey<R>(
    run: (context: NekAgentCommandContext, sessionKey: string) => Promise<R>,
    invalidates?: "index" | "config",
  ): (sessionKey: string) => Promise<R> {
    const invoke = this.forInput<{ sessionKey: string }, R>(
      (context, input) => run(context, input.sessionKey),
      invalidates,
    );
    return (sessionKey) => invoke({ sessionKey });
  }

  // ---- 输入 ----
  /**
   * 发送输入。压缩进行中 GUI 自己暂存（不发给 CLI），压缩收口后按提交顺序提交。
   *
   * 只有 nek 真正接纳（RPC 返回）才把 ownership 交给 CLI；压缩本身不是发送错误，
   * 压缩被取消/断线/关闭时这次发送可见失败，草稿回到输入框。
   */
  readonly sendPrompt: Methods["sendPrompt"] = async (input) => {
    const record = this.requireRecord(input.sessionKey);
    // 压缩期间暂存的输入在收口时可能已经有一轮在跑（前一条待发输入起了新回合）：
    // 用户那次"发送"默认按排队处理，不把它变成准入错误。
    const effective =
      this.pendingInputs.isCompacting(record) && input.streamingBehavior === undefined
        ? { ...input, streamingBehavior: "followUp" as const }
        : input;
    return await this.pendingInputs.defer(
      record,
      async () =>
        await this.withSession(
          input.sessionKey,
          async () => await commands.sendPrompt(this.commandContext(), effective),
        ),
    );
  };
  readonly abort: Methods["abort"] = async (sessionKey) => {
    // 停止是用户明确取消：压缩中的待发输入不能在他停止之后补发。
    this.pendingInputs.cancel(
      this.requireRecord(sessionKey),
      new NekPendingInputCancelledError("已停止，消息没有发送；草稿已保留，可重试"),
    );
    await this.withSession(
      sessionKey,
      async () => await commands.abort(this.commandContext(), sessionKey),
    );
  };
  readonly bash: Methods["bash"] = this.forInput(commands.bash);
  readonly abortBash: Methods["abortBash"] = this.forKey(commands.abortBash);
  readonly clearQueue: Methods["clearQueue"] = this.forKey(commands.clearQueue);
  readonly retrieveQueue: Methods["retrieveQueue"] = this.forKey(commands.retrieveQueue);

  /**
   * 压缩进行中把一段"发送前准备 + 发送"整体挂起，压缩收口后按提交顺序执行；否则立即执行。
   *
   * 适配层用它避免压缩期间预提交 setModel/thinking/mode：这些配置写入要么被 nek 拒绝，
   * 要么把本次输入框的选择错写到另一半；附件解析也留到真正接纳之前。
   */
  async deferInput<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    return await this.pendingInputs.defer(this.requireRecord(sessionKey), run);
  }

  /** 会话是否在压缩（含 GUI 预约）；适配层据此判断能否预提交配置。 */
  isCompacting(sessionKey: string): boolean {
    return this.pendingInputs.isCompacting(this.requireRecord(sessionKey));
  }

  /** 该会话还有多少条 GUI 暂存的待发送输入（压缩中）；诊断与状态展示用。 */
  pendingInputCount(sessionKey: string): number {
    return this.pendingInputs.pendingCount(sessionKey);
  }

  // ---- 会话操作 ----
  /**
   * 手动压缩。GUI 在首个 await 之前就预约"压缩中"：同一 tick 里随后提交的输入
   * 会进 GUI 待发队列，而不是抢跑到 CLI 打乱这次压缩。
   */
  readonly compact: Methods["compact"] = async (input) => {
    const record = this.requireWritable(input.sessionKey);
    record.compactReserved = true;
    try {
      return await this.withSession(
        input.sessionKey,
        async () => await commands.compact(this.commandContext(), input),
      );
    } catch (error) {
      // 压缩根本没开始：撤掉预约，把待发输入按正常顺序放行，错误照常上报。
      record.compactReserved = false;
      this.pendingInputs.settle(record);
      throw error;
    }
  };
  readonly setModel: Methods["setModel"] = this.forInput(commands.setModel, "config");
  readonly cycleModel: Methods["cycleModel"] = this.forKey(commands.cycleModel, "config");
  readonly setThinkingLevel: Methods["setThinkingLevel"] = this.forInput(
    commands.setThinkingLevel,
    "config",
  );
  readonly setThoughtLevel: Methods["setThoughtLevel"] = this.setThinkingLevel;
  readonly cycleThinkingLevel: Methods["cycleThinkingLevel"] = this.forKey(
    commands.cycleThinkingLevel,
    "config",
  );
  readonly cycleThoughtLevel: Methods["cycleThoughtLevel"] = this.cycleThinkingLevel;
  readonly setMode: Methods["setMode"] = this.forInput(commands.setMode, "config");
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

  readonly reload: Methods["reload"] = this.forKey(commands.reload, "config");
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
  readonly importSession: Methods["importSession"] = async (input) => {
    const result = await commands.importSession(this.commandContext(), input);
    this.emit({ type: "catalog_changed", topic: "index", cwd: input.cwd });
    return result;
  };

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

  /** Fork replaces nek's runtime. Reopen its actual path so pool keys and UI scopes stay session-bound. */
  async forkSession(input: {
    sessionKey: string;
    entryId: string;
  }): Promise<{ cancelled: true } | { cancelled: false; text: string; session: NekSessionResult }> {
    const record = this.requireWritable(input.sessionKey);
    const forked = await this.withSession(input.sessionKey, async () => {
      const result = await commands.fork(this.commandContext(), input);
      if (result.cancelled) return null;
      try {
        const state = await this.requireProcess(record).client.call({ type: "get_state" });
        if (
          !state.sessionFile ||
          state.sessionId === record.sessionId ||
          typeof result.text !== "string"
        )
          throw new Error("nek fork did not return a new session and editor text");
        return { path: state.sessionFile, text: result.text };
      } finally {
        // The process now owns the fork, not the source. Never leave a source-keyed writer behind.
        await this.closeSession(input.sessionKey);
      }
    });
    if (!forked) return { cancelled: true };
    const session = await this.resumeSession({ sessionPath: forked.path, cwd: record.cwd });
    return { cancelled: false, text: forked.text, session };
  }

  async closeSession(sessionKey: string | { sessionKey: string }): Promise<boolean> {
    const record = this.requireRecord(
      typeof sessionKey === "string" ? sessionKey : sessionKey.sessionKey,
    );
    record.closing = true;
    this.detachProcess(record);
    await this.pool.reclaimSession(record.key, "dispose");
    this.removeRecord(record);
    this.emit({ type: "catalog_changed", topic: "index", cwd: record.cwd });
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
    this.emit({
      type: "catalog_changed",
      topic: "index",
      cwd: this.resolveRecord(input.sessionKey ?? path)?.cwd,
    });
  }

  /** 先关闭持锁的会话进程再删文件：nek 拒绝删除被活进程锁住的会话。 */
  async deleteSession(input: { sessionKey?: string; sessionPath?: string }): Promise<void> {
    const record = input.sessionKey ? this.resolveRecord(input.sessionKey) : undefined;
    const path = input.sessionPath ?? record?.path;
    if (!path) throw new Error("deleteSession requires sessionPath");
    if (record) await this.closeSession(record.key);
    const control = await this.pool.ensureControl();
    await control.client.call({ type: "delete_session", sessionPath: path });
    this.emit({ type: "catalog_changed", topic: "index", cwd: record?.cwd });
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

  /**
   * 预览按 512 KB 分块读取同一张图，每块都重新翻页会放大 RPC 次数；
   * 用按字节封顶的 LRU 缓存最近解析的图片（ref 含会话与内容哈希，可跨会话共用）。
   */
  async readUserImage(sessionKey: string, ref: string): Promise<NekImageContent> {
    const key = `${this.requireRecord(sessionKey).sessionId}\0${ref}`;
    const cached = this.userImageCache.get(key);
    if (cached) {
      this.userImageCache.delete(key);
      this.userImageCache.set(key, cached);
      return cached;
    }
    const image = await this.resolveUserImage(sessionKey, ref);
    this.cacheUserImage(key, image);
    return image;
  }

  /** 普通附件只解析会话内的元数据；字节由已授权的分块预览入口按需读取。 */
  async readUserFile(sessionKey: string, ref: string): Promise<NekStoredAttachment> {
    const record = this.requireRecord(sessionKey);
    return await this.withSession(sessionKey, () =>
      resolveNekSessionAttachment(
        record,
        (entries) => findNekUserFile(record.sessionId, ref, entries),
        () => this.requireProcess(record).client,
        "file",
      ),
    );
  }

  private readonly userImageCache = new Map<string, NekImageContent>();
  private userImageCacheChars = 0;

  private cacheUserImage(ref: string, image: NekImageContent): void {
    if (image.data.length > USER_IMAGE_CACHE_MAX_CHARS) return;
    this.userImageCache.set(ref, image);
    this.userImageCacheChars += image.data.length;
    for (const [oldRef, old] of this.userImageCache) {
      if (this.userImageCacheChars <= USER_IMAGE_CACHE_MAX_CHARS) break;
      this.userImageCache.delete(oldRef);
      this.userImageCacheChars -= old.data.length;
    }
  }

  /** 只读会话复用已有快照，可写会话逐页向 nek 解析，离开一页即释放。 */
  private async resolveUserImage(sessionKey: string, ref: string): Promise<NekImageContent> {
    const locator = parseNekUserImageRef(ref);
    const record = this.requireRecord(sessionKey);
    return await this.withSession(sessionKey, () =>
      resolveNekSessionAttachment(
        record,
        (entries) => findNekUserImage(record.sessionId, ref, locator, entries),
        () => this.requireProcess(record).client,
        "image",
      ),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // 待发送输入随服务一起结束：可见失败，绝不在下次启动时补发。
    this.pendingInputs.cancelAll(
      new NekPendingInputCancelledError("nek agent service has been disposed"),
    );
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
      capabilities: process.guiInfo.capabilities,
      projector: record.projector,
      phase: record.phase,
      isCompacting: this.pendingInputs.isCompacting(record),
      setPhase: (phase) => this.setPhase(record, phase),
    };
  }
}
