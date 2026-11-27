/**
 * 设置中心后端的运行时：目标解析、控制进程缓存、配置监视、写后重载、登录管理。
 *
 * 每个功能模块（models / settings / mcp / …）都只拿这一个运行时，避免它们各自
 * 去猜目标、进程与通知的细节。
 */
import { randomUUID } from "node:crypto";
import type {
  NekModelReadContext,
  NekConfigTarget,
  NekConfigTargetInfo,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
  NekSessionReloadOutcome,
  NekModelRuntimeFreshness,
  NekReloadResult,
} from "@zcode/shared/nek-protocol";
import type { NekControlClient } from "./control.js";
import { notConnected } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { NekLoginManager } from "./login.js";
import { NekWatchHub } from "./watch.js";
import type { NekWatchChange } from "./watch.js";
import { agentsDir, projectConfigDir } from "./paths.js";
import { emptyReloadOutcome, reloadChangesForWrite, reloadLiveSessions } from "./reloadSessions.js";
import { NekLiveModelRuntimes } from "./liveModelRuntimes.js";
import { NekModelControls } from "./modelControls.js";
import {
  announcementPath,
  observeReloadAnnouncements,
  writeReloadAnnouncement,
  type ReloadChange,
  type ReloadTrigger,
} from "./reloadAnnouncements.js";

/** 目标机器上一个正在运行的 nek 会话进程。 */
export interface NekConfigSessionHandle {
  sessionKey: string;
  cwd?: string;
  /** Recheck the captured process identity before dispatching after another session's await. */
  isLive?: () => boolean;
  /** 回合正在运行：reload 会被推迟到回合结束后。 */
  busy: boolean;
  /** Content-deduped path for models-only write notifications. */
  refreshModels?: () => Promise<NekReloadResult>;
  call: <C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ) => Promise<NekRpcResponseDataFor<C>>;
}

/** 会话进程登记表（由会话服务实现并注入）。 */
export interface NekConfigSessionRegistry {
  sessions: (target: NekConfigTarget) => NekConfigSessionHandle[];
}

/** 目标机器集合：本机 + 已连接的远程主机。 */
export interface NekConfigTargetHost {
  listTargets: () => Promise<NekConfigTargetInfo[]>;
  /** 取执行器；目标未连接（或不存在）时返回 undefined。 */
  executor: (target: NekConfigTarget) => NekConfigHostExecutor | undefined;
}

export interface NekConfigApiConfig {
  /** 远程目标的配置轮询间隔（秒），来自 GUI 的 `config/config.yaml` `remote.configPollSeconds`。 */
  remoteConfigPollSeconds?: number;
  /** 本机 watch 防抖（毫秒）。 */
  watchDebounceMs?: number;
  /** 每次写盘后自动重载 nek 进程；默认 true。 */
  autoReload?: boolean;
  /** Whole model menu read, including startup and queueing. */
  modelReadMs?: number;
}

/**
 * 从 GUI 运行参数（`config/config.yaml`）里取设置中心需要的值。
 *
 * 只取真正属于 GUI 的开关：轮询间隔来自 `remote.configPollSeconds`（远程目标每 N 秒 stat 一次），
 * 自动重载默认开启、可由 host 关掉。
 */
export function nekConfigApiConfigFromRuntime(
  runtime: { remote?: { configPollSeconds?: number }; timeouts?: { modelReadMs?: number } },
  overrides: NekConfigApiConfig = {},
): NekConfigApiConfig {
  return {
    ...(runtime.remote?.configPollSeconds !== undefined
      ? { remoteConfigPollSeconds: runtime.remote.configPollSeconds }
      : {}),
    ...(runtime.timeouts?.modelReadMs !== undefined
      ? { modelReadMs: runtime.timeouts.modelReadMs }
      : {}),
    ...overrides,
  };
}

export interface NekConfigApiLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface NekLoginPortForward {
  ports: number[];
  close(): Promise<void>;
}

export interface NekConfigApiOptions {
  hosts: NekConfigTargetHost;
  sessions?: NekConfigSessionRegistry;
  /** 控制进程工厂（测试注入假实现）。 */
  control?: (args: {
    target: NekConfigTarget;
    executor: NekConfigHostExecutor;
    logger?: NekConfigApiLogger;
    context?: NekModelReadContext;
  }) => Promise<NekControlClient>;
  /** 远程登录的端口转发（host 侧 SSH 实现）；调用方必须在登录结束后关闭 lease。 */
  forwardLoginPorts?: (target: NekConfigTarget, ports: number[]) => Promise<NekLoginPortForward>;
  config?: NekConfigApiConfig;
  logger?: NekConfigApiLogger;
}

export interface NekTargetContext {
  target: NekConfigTarget;
  key: string;
  executor: NekConfigHostExecutor;
  layout: { agentDir: string };
}

export type NekReloadOutcome = NekSessionReloadOutcome;

export function targetKeyOf(target: NekConfigTarget): string {
  return target.kind === "local" ? "local" : `remote:${target.connectionId}`;
}

export class NekConfigRuntime {
  readonly login: NekLoginManager;
  private disposed = false;
  private readonly watchHub: NekWatchHub;
  private readonly reloadListeners = new Map<string, Set<(result: NekReloadOutcome) => void>>();
  private readonly autoReload: boolean;
  private readonly origin = randomUUID();
  private stopAnnouncements?: () => void;
  private readonly modelControls: NekModelControls;
  private readonly liveModels = new NekLiveModelRuntimes({
    watch: (target, listener) => this.watch(target, listener),
    report: (target, result) => this.emitReloadResult(target, result),
    warn: (...args) => this.logger?.warn(...args),
  });

  /** Connect the machine-local session owner; registrations never create/reopen a process. */
  modelRuntime(target: NekConfigTarget): NekModelRuntimeFreshness {
    // Target resolution is lazy so host construction does not perform IO/start nek.
    return {
      register: (handle, registration) =>
        this.liveModels.forTarget(this.target(target)).register(handle, registration),
    };
  }

  constructor(private readonly options: NekConfigApiOptions) {
    const config = options.config ?? {};
    this.autoReload = config.autoReload ?? true;
    this.watchHub = new NekWatchHub({
      debounceMs: config.watchDebounceMs,
      pollSeconds: config.remoteConfigPollSeconds,
      logger: options.logger,
    });
    this.modelControls = new NekModelControls({
      config: options,
      target: (target) => this.target(target),
      owner: this.liveModels.owner,
      watch: (target, listener) => this.watch(target, listener),
      report: (target, result) => this.emitReloadResult(target, result),
    });
    this.login = new NekLoginManager({
      control: (target, context) => this.control(target, context),
      abort: (target) => this.abortControl(target),
      onAuthChanged: (target) => this.publishAuthChange(target),
      forwardPorts: options.forwardLoginPorts,
      logger: options.logger,
    });
  }

  get logger(): NekConfigApiLogger | undefined {
    return this.options.logger;
  }

  /** 解析目标；未连接时抛 `not_connected`。 */
  target(target: NekConfigTarget): NekTargetContext {
    if (this.disposed) throw new Error("nek config runtime disposed");
    const executor = this.options.hosts.executor(target);
    if (!executor) throw notConnected(target);
    return {
      target,
      key: targetKeyOf(target),
      executor,
      layout: { agentDir: executor.agentDir() },
    };
  }

  /** Control identity/freshness belongs to this runtime, never the facts consumer. */
  control(target: NekConfigTarget, read?: NekModelReadContext): Promise<NekControlClient> {
    return this.modelControls.get(target, read);
  }

  abortControl(target: NekConfigTarget): Promise<void> {
    return this.modelControls.abort(target);
  }

  /** Control-only freshness: never joins the live-session/MCP reload-all path. */
  refreshModelControl(
    target: NekConfigTarget,
    read?: NekModelReadContext,
  ): Promise<NekReloadOutcome> {
    return this.modelControls.refresh(target, read);
  }

  /** 目标机器上正在运行的会话进程（MCP 状态、reload 用）。 */
  sessionsOf(target: NekConfigTarget): NekConfigSessionHandle[] {
    const live = this.liveModels.sessions(targetKeyOf(target));
    return [...live, ...(this.options.sessions?.sessions(target) ?? [])];
  }

  /**
   * 目标 nek 的版本（来自 host 的目标表）。
   *
   * 未安装 / 不兼容 / 状态未知都返回 `undefined`：调用方必须把"版本未知"当成
   * "不能证明支持"，而不是当成最新版本。目标表本身取不到时也不吞错以外的东西——
   * 失败一律返回 `undefined`，能力门禁随之落到保守的一侧。
   */
  async targetNekVersion(target: NekConfigTarget): Promise<string | undefined> {
    const key = targetKeyOf(target);
    let targets: NekConfigTargetInfo[];
    try {
      targets = await this.options.hosts.listTargets();
    } catch (error) {
      this.options.logger?.warn("failed to list targets while resolving the nek version", error);
      return undefined;
    }
    const info = targets.find((entry) => targetKeyOf(entry.target) === key);
    return info?.nek.state === "ready" ? info.nek.version : undefined;
  }

  /** 监视配置目录；`fs.watch`（本机）或轮询（远程）。 */
  watch(
    target: NekConfigTarget,
    listener: (change: NekWatchChange) => void,
    cwd?: string,
  ): (() => void) & { readonly ready: Promise<void> } {
    const context = this.target(target);
    return this.watchHub.subscribe(
      {
        key: context.key,
        executor: context.executor,
        local: target.kind === "local",
        dirs: this.watchDirs(context, cwd),
      },
      listener,
    );
  }

  /** Persist the notification before acknowledging a write; live results arrive separately. */
  async publishWrite(
    target: NekConfigTarget,
    files: ReadonlyArray<{ path: string; revision: string }>,
    scope?: { cwd?: string },
  ): Promise<void> {
    if (!files.length) return;
    this.watchHub.publish(
      targetKeyOf(target),
      files.map((file) => ({ file: file.path, revision: file.revision })),
    );
    await this.publishAutomatic(target, "write", ({ layout }) =>
      reloadChangesForWrite(layout.agentDir, files, scope),
    );
  }

  private async publishAuthChange(target: NekConfigTarget): Promise<void> {
    // The auth RPC has already updated this runtime's control process. Never write credentials here.
    await this.publishAutomatic(target, "login", () => [
      { trigger: "login", files: ["auth.json"] },
    ]);
  }

  private async publishAutomatic(
    target: NekConfigTarget,
    trigger: ReloadTrigger,
    prepare: (context: NekTargetContext) => ReloadChange[],
  ): Promise<void> {
    if (!this.autoReload || this.disposed) return;
    try {
      const context = this.target(target);
      const changes = prepare(context);
      const outcome = await this.announce(context, changes, trigger);
      // Config and announcement are already on disk. An RPC result must not turn that write into
      // a failed save/login (or prompt a caller to replay a credential mutation).
      void this.reload(context, changes, trigger === "write", outcome).then(() =>
        this.emitReloadResult(target, outcome),
      );
    } catch (error) {
      const outcome = emptyReloadOutcome(trigger);
      this.reportAnnouncementFailure(outcome, error);
      this.emitReloadResult(target, outcome);
    }
  }

  /** The settings owner only publishes. Desktop host and gui-server opt into local observation. */
  observeAnnouncements(target: Extract<NekConfigTarget, { kind: "local" }>): void {
    if (this.stopAnnouncements) return;
    const context = this.target(target);
    this.stopAnnouncements = observeReloadAnnouncements({
      executor: context.executor,
      agentDir: context.layout.agentDir,
      origin: this.origin,
      debounceMs: this.options.config?.watchDebounceMs,
      pollSeconds: this.options.config?.remoteConfigPollSeconds,
      receive: async (changes) => {
        const pending = this.autoReload
          ? changes
          : changes.filter(({ trigger }) => trigger === "manual");
        if (!pending.length || !this.sessionsOf(target).length) return;
        const outcomes = await this.reload(context, pending, false);
        for (const outcome of outcomes) this.emitReloadResult(target, outcome);
      },
      fail: (message) => {
        this.logger?.warn("nek config reload observation failed", message);
        if (!this.sessionsOf(target).length) return;
        const outcome = emptyReloadOutcome();
        outcome.failures.push({ sessionKey: "announcement", message });
        this.emitReloadResult(target, outcome);
      },
    });
  }

  /** Deliver to this owner and notify the rest of the target machine, not other machines. */
  async reloadRunningSessions(target: NekConfigTarget, cwd?: string): Promise<NekReloadOutcome> {
    const context = this.target(target);
    const changes: ReloadChange[] = [{ trigger: "manual", cwd, files: [] }];
    const outcome = await this.announce(context, changes, "manual");
    await this.reload(context, changes, true, outcome);
    return outcome;
  }

  private async announce(
    context: NekTargetContext,
    changes: readonly ReloadChange[],
    trigger: ReloadTrigger,
  ): Promise<NekReloadOutcome> {
    const outcome = emptyReloadOutcome(trigger);
    try {
      await writeReloadAnnouncement(
        context.executor,
        announcementPath(context.layout.agentDir),
        this.origin,
        changes,
      );
      outcome.announced = true;
    } catch (error) {
      this.reportAnnouncementFailure(outcome, error);
    }
    return outcome;
  }

  private reportAnnouncementFailure(outcome: NekReloadOutcome, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger?.warn("nek config reload announcement failed", error);
    outcome.announced = false;
    outcome.failures.push({
      sessionKey: "announcement",
      message: `Could not notify this machine's tasks: ${message}. Retry Reload.`,
    });
  }

  onReloadResult(
    target: NekConfigTarget,
    listener: (result: NekReloadOutcome) => void,
  ): () => void {
    const key = targetKeyOf(target);
    const listeners = this.reloadListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.reloadListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.reloadListeners.delete(key);
    };
  }

  private reload(
    context: NekTargetContext,
    changes: readonly ReloadChange[],
    includeControl: boolean,
    direct?: NekReloadOutcome,
  ): Promise<NekReloadOutcome[]> {
    const { target, layout, executor } = context;
    return reloadLiveSessions({
      agentDir: layout.agentDir,
      changes,
      direct,
      current: () => !this.disposed && this.options.hosts.executor(target) === executor,
      sessions: () => this.sessionsOf(target),
      control: includeControl
        ? async (modelsOnly) => {
            if (!this.modelControls.has(target)) return;
            if (modelsOnly) return await this.modelControls.refreshContent(target, {});
            return await (await this.control(target)).call({ type: "reload" }, {});
          }
        : undefined,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnnouncements?.();
    this.modelControls.dispose();
    this.liveModels.owner.dispose();
    this.watchHub.dispose();
    this.login.dispose();
    this.reloadListeners.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private watchDirs(
    context: NekTargetContext,
    cwd?: string,
  ): Array<{ path: string; scope: "global" | "project" }> {
    const dirs: Array<{ path: string; scope: "global" | "project" }> = [
      { path: context.layout.agentDir, scope: "global" },
      { path: agentsDir(context.layout, "global"), scope: "global" },
    ];
    if (cwd) {
      dirs.push(
        { path: projectConfigDir(cwd), scope: "project" },
        { path: agentsDir(context.layout, "project", cwd), scope: "project" },
        { path: cwd, scope: "project" },
      );
    }
    return dirs;
  }

  private emitReloadResult(target: NekConfigTarget, result: NekReloadOutcome): void {
    const listeners = this.reloadListeners.get(targetKeyOf(target));
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(result);
      } catch (error) {
        this.options.logger?.warn("reload result listener threw", error);
      }
    }
  }
}
