/**
 * 设置中心后端的运行时：目标解析、控制进程缓存、配置监视、写后重载、登录管理。
 *
 * 每个功能模块（models / settings / mcp / …）都只拿这一个运行时，避免它们各自
 * 去猜目标、进程与通知的细节。
 */
import { basename, dirname, relative, normalize } from "node:path";
import type {
  NekConfigDiagnostic,
  NekConfigTarget,
  NekConfigTargetInfo,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
  NekSessionReloadOutcome,
} from "@zcode/shared/nek-protocol";
import type { NekControlClient } from "./control.js";
import { createNekControlClient } from "./control.js";
import { notConnected } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { NekLoginManager } from "./login.js";
import { NekWatchHub } from "./watch.js";
import type { NekWatchChange } from "./watch.js";
import { agentsDir, projectConfigDir } from "./paths.js";

/** 目标机器上一个正在运行的 nek 会话进程。 */
export interface NekConfigSessionHandle {
  sessionKey: string;
  cwd?: string;
  /** 回合正在运行：reload 会被推迟到回合结束后。 */
  busy: boolean;
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
}

/**
 * 从 GUI 运行参数（`config/config.yaml`）里取设置中心需要的值。
 *
 * 只取真正属于 GUI 的开关：轮询间隔来自 `remote.configPollSeconds`（远程目标每 N 秒 stat 一次），
 * 自动重载默认开启、可由 host 关掉。
 */
export function nekConfigApiConfigFromRuntime(
  runtime: { remote?: { configPollSeconds?: number } },
  overrides: NekConfigApiConfig = {},
): NekConfigApiConfig {
  return {
    ...(runtime.remote?.configPollSeconds !== undefined
      ? { remoteConfigPollSeconds: runtime.remote.configPollSeconds }
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
  private readonly watchHub: NekWatchHub;
  private readonly controls = new Map<string, Promise<NekControlClient>>();
  private readonly reloadListeners = new Map<string, Set<(result: NekReloadOutcome) => void>>();
  private readonly autoReload: boolean;

  constructor(private readonly options: NekConfigApiOptions) {
    const config = options.config ?? {};
    this.autoReload = config.autoReload ?? true;
    this.watchHub = new NekWatchHub({
      debounceMs: config.watchDebounceMs,
      pollSeconds: config.remoteConfigPollSeconds,
      logger: options.logger,
    });
    this.login = new NekLoginManager({
      control: (target) => this.control(target),
      abort: (target) => this.abortControl(target),
      forwardPorts: options.forwardLoginPorts,
      logger: options.logger,
    });
  }

  get logger(): NekConfigApiLogger | undefined {
    return this.options.logger;
  }

  /** 解析目标；未连接时抛 `not_connected`。 */
  target(target: NekConfigTarget): NekTargetContext {
    const executor = this.options.hosts.executor(target);
    if (!executor) throw notConnected(target);
    return {
      target,
      key: targetKeyOf(target),
      executor,
      layout: { agentDir: executor.agentDir() },
    };
  }

  /** 控制进程（每个目标一个，懒启动）。 */
  async control(target: NekConfigTarget): Promise<NekControlClient> {
    const context = this.target(target);
    const existing = this.controls.get(context.key);
    if (existing) return await existing;
    const factory = this.options.control ?? defaultControlFactory;
    const created = factory({ target, executor: context.executor, logger: this.options.logger });
    this.controls.set(context.key, created);
    try {
      return await created;
    } catch (error) {
      this.controls.delete(context.key);
      throw error;
    }
  }

  /** 中断控制进程（取消登录时使用）：下次调用会重新懒启动。 */
  async abortControl(target: NekConfigTarget): Promise<void> {
    const key = targetKeyOf(target);
    const existing = this.controls.get(key);
    this.controls.delete(key);
    if (existing) await (await existing.catch(() => undefined))?.close();
  }

  /** 有没有已经启动的控制进程（`reload` 不该为了重载而新建进程）。 */
  hasControl(target: NekConfigTarget): boolean {
    return this.controls.has(targetKeyOf(target));
  }

  /** 目标机器上正在运行的会话进程（MCP 状态、reload 用）。 */
  sessionsOf(target: NekConfigTarget): NekConfigSessionHandle[] {
    return this.options.sessions?.sessions(target) ?? [];
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
  ): () => void {
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

  /** 写盘后的通知：先推 watch 事件，再触发一次重载。 */
  publishWrite(
    target: NekConfigTarget,
    files: ReadonlyArray<{ path: string; revision: string }>,
  ): void {
    const key = targetKeyOf(target);
    this.watchHub.publish(
      key,
      files.map((file) => ({ file: file.path, revision: file.revision })),
    );
    if (!this.autoReload) return;
    const agentDir = this.target(target).layout.agentDir;
    const workspaces = new Set(files.map((file) => workspaceOfWrite(agentDir, file.path)));
    const cwd = workspaces.size === 1 ? [...workspaces][0] : undefined;
    void this.reload(target, cwd)
      .then((result) => this.emitReloadResult(target, result))
      .catch((error: unknown) => {
        this.options.logger?.warn("automatic reload after a config write failed", error);
        this.emitReloadResult(target, {
          reloaded: 0,
          deferred: 0,
          diagnostics: [],
          failures: [
            {
              sessionKey: "runtime",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        });
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

  /** 对目标机器上所有 nek 进程发 reload。回合正在跑的计入 deferred。 */
  async reload(target: NekConfigTarget, cwd?: string): Promise<NekReloadOutcome> {
    this.target(target);
    const diagnostics: NekConfigDiagnostic[] = [];
    const failures: NekReloadOutcome["failures"] = [];
    let reloaded = 0;
    let deferred = 0;
    const sessions = this.options.sessions?.sessions(target) ?? [];
    for (const session of sessions) {
      if (cwd && (!session.cwd || normalize(session.cwd) !== normalize(cwd))) continue;
      const outcome = await this.reloadOne(session.sessionKey, session.busy, () =>
        session.call({ type: "reload" }),
      );
      reloaded += outcome.reloaded;
      deferred += outcome.deferred;
      diagnostics.push(...outcome.diagnostics);
      failures.push(...outcome.failures);
    }
    if (this.hasControl(target)) {
      const outcome = await this.reloadOne("control", false, async () => {
        const control = await this.control(target);
        return await control.call({ type: "reload" });
      });
      reloaded += outcome.reloaded;
      deferred += outcome.deferred;
      diagnostics.push(...outcome.diagnostics);
      failures.push(...outcome.failures);
    }
    return { reloaded, deferred, diagnostics, failures };
  }

  dispose(): void {
    this.watchHub.dispose();
    this.login.dispose();
    for (const pending of this.controls.values()) {
      void pending.then((client) => client.close()).catch(() => undefined);
    }
    this.controls.clear();
    this.reloadListeners.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private async reloadOne(
    label: string,
    busy: boolean,
    call: () => Promise<{ deferred: boolean; diagnostics: NekConfigDiagnostic[] }>,
  ): Promise<NekReloadOutcome> {
    try {
      const result = await call();
      const queued = result.deferred || busy;
      return {
        reloaded: queued ? 0 : 1,
        deferred: queued ? 1 : 0,
        diagnostics: result.diagnostics,
        failures: [],
      };
    } catch (error) {
      return {
        reloaded: 0,
        deferred: 0,
        diagnostics: [],
        failures: [
          {
            sessionKey: label,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

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

/** Global writes affect all sessions; project files affect only their owning workspace. */
function workspaceOfWrite(agentDir: string, file: string): string | undefined {
  const path = relative(agentDir, file);
  if (path && !path.startsWith("..")) return undefined;
  let directory = dirname(file);
  while (dirname(directory) !== directory) {
    if (basename(directory) === ".nek") return dirname(directory);
    directory = dirname(directory);
  }
  return dirname(file);
}

/** 默认控制进程工厂（真机）；测试通过 `options.control` 注入假实现。 */
async function defaultControlFactory(args: {
  target: NekConfigTarget;
  executor: NekConfigHostExecutor;
  logger?: NekConfigApiLogger;
}): Promise<NekControlClient> {
  return await createNekControlClient(args);
}
