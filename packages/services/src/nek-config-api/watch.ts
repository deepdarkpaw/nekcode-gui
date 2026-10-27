/**
 * 配置文件监视：本机 `fs.watch`（防抖），远程定时 `stat`。
 *
 * 为什么要两条路径：本机可以直接拿 inotify/ReadDirectoryChangesW（事件即时），
 * 而远程目标没有文件系统事件通道，只能按 `remote.configPollSeconds` 轮询。
 * 两者对外行为一致：只在**内容 revision 真的变了**时推 `{file, revision}`，
 * 本端刚写完的那次变化由 `publish` 直接送达，不等文件系统事件。
 */
import { watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { baselineConfigFiles } from "./watchFiles.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { ABSENT_REVISION } from "./revision.js";
import { readTextDocument } from "./documents.js";

export interface NekWatchChange {
  file: string;
  revision: string;
}

export interface NekWatchTarget {
  /** 目标键（`local` / `remote:<id>`）。 */
  key: string;
  executor: NekConfigHostExecutor;
  /** 是否本机（决定 fs.watch 还是轮询）。 */
  local: boolean;
  /** 需要监视的目录（agent 目录、项目 `.nek` 及其 `agents/`）。 */
  dirs: string[];
}

export interface NekWatchHubOptions {
  /** 本机 fs.watch 的防抖，默认 200 ms。 */
  debounceMs?: number;
  /** 远程轮询间隔（秒），来自 `remote.configPollSeconds`，默认 5。 */
  pollSeconds?: number;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

interface WatchState {
  target: NekWatchTarget;
  listeners: Set<(change: NekWatchChange) => void>;
  episodes: Map<string, { mtimeMs: number; size: number; revision: string }>;
  stop: () => void;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_POLL_SECONDS = 5;

export class NekWatchHub {
  private readonly states = new Map<string, WatchState>();
  private readonly debounceMs: number;
  private readonly pollSeconds: number;
  private readonly logger: NekWatchHubOptions["logger"];

  constructor(options: NekWatchHubOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollSeconds = Math.max(1, options.pollSeconds ?? DEFAULT_POLL_SECONDS);
    this.logger = options.logger;
  }

  /** 订阅某个目标的变化；返回退订函数。同一目标共享一个监视器。 */
  subscribe(target: NekWatchTarget, listener: (change: NekWatchChange) => void): () => void {
    const existing = this.states.get(target.key);
    if (existing) {
      existing.listeners.add(listener);
      return () => this.unsubscribe(target.key, listener);
    }
    const state: WatchState = {
      target,
      listeners: new Set([listener]),
      episodes: new Map(),
      stop: () => undefined,
    };
    this.states.set(target.key, state);
    void this.prime(state).then(() => {
      if (this.states.get(target.key) === state) state.stop = this.start(state);
    });
    return () => this.unsubscribe(target.key, listener);
  }

  /** 本端写入后的即时通知（不等文件系统事件）。 */
  publish(targetKey: string, changes: readonly NekWatchChange[]): void {
    const state = this.states.get(targetKey);
    for (const change of changes) {
      if (state)
        state.episodes.set(change.file, { mtimeMs: 0, size: 0, revision: change.revision });
      this.emit(targetKey, change);
    }
  }

  /** 目录集合变了（切换了项目目录）：重建监视器，保留订阅者。 */
  refresh(target: NekWatchTarget): void {
    const state = this.states.get(target.key);
    if (!state) return;
    state.stop();
    state.target = target;
    state.episodes.clear();
    void this.prime(state).then(() => {
      if (this.states.get(target.key) === state) state.stop = this.start(state);
    });
  }

  dispose(): void {
    for (const state of this.states.values()) state.stop();
    this.states.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private unsubscribe(key: string, listener: (change: NekWatchChange) => void): void {
    const state = this.states.get(key);
    if (!state) return;
    state.listeners.delete(listener);
    if (state.listeners.size > 0) return;
    state.stop();
    this.states.delete(key);
  }

  private emit(key: string, change: NekWatchChange): void {
    const state = this.states.get(key);
    if (!state) return;
    for (const listener of Array.from(state.listeners)) {
      try {
        listener(change);
      } catch (error) {
        this.logger?.warn("nek config watch listener threw", error);
      }
    }
  }

  /** 记录当前状态，避免订阅瞬间把已有文件当成"刚变化"。 */
  private async prime(state: WatchState): Promise<void> {
    state.episodes = await this.scan(state.target).catch((error: unknown) => {
      this.logger?.warn("failed to scan config files for watching", error);
      return new Map();
    });
  }

  private start(state: WatchState): () => void {
    return state.target.local ? this.startFsWatch(state) : this.startPolling(state);
  }

  private startFsWatch(state: WatchState): () => void {
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void this.rescan(state);
      }, this.debounceMs);
      timer.unref?.();
    };
    for (const dir of state.target.dirs) {
      try {
        const watcher = fsWatch(dir, { persistent: false }, () => schedule());
        watcher.on("error", (error) => this.logger?.warn(`fs.watch failed for ${dir}`, error));
        watchers.push(watcher);
      } catch (error) {
        // 目录还不存在（首次运行、项目没有 .nek）：轮询兜底会让它"永远不开始"，所以这里只记日志。
        this.logger?.debug?.(`cannot watch ${dir}`, error);
      }
    }
    if (watchers.length === 0) {
      this.logger?.debug?.(
        "no directory could be watched; falling back to polling",
        state.target.key,
      );
      return this.startPolling(state);
    }
    return () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  private startPolling(state: WatchState): () => void {
    const timer = setInterval(() => void this.rescan(state), this.pollSeconds * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async rescan(state: WatchState): Promise<void> {
    let scanned: Map<string, { mtimeMs: number; size: number; revision: string }>;
    try {
      scanned = await this.scan(state.target);
    } catch (error) {
      this.logger?.warn("failed to rescan config files", error);
      return;
    }
    const changes: NekWatchChange[] = [];
    for (const [file, entry] of scanned) {
      const previous = state.episodes.get(file);
      if (previous && previous.revision === entry.revision) continue;
      changes.push({ file, revision: entry.revision });
    }
    for (const file of state.episodes.keys()) {
      if (!scanned.has(file)) changes.push({ file, revision: ABSENT_REVISION });
    }
    state.episodes = scanned;
    for (const change of changes) this.emit(state.target.key, change);
  }

  /**
   * 扫一遍受监视的目录。
   *
   * 轮询模式下只对 mtime/size 变过的文件重新读+哈希：远程每 5 s 一次全量读会把
   * 慢链路拖死；但是否"变过"必须用上次扫描到的元信息判断。
   */
  private async scan(
    target: NekWatchTarget,
  ): Promise<Map<string, { mtimeMs: number; size: number; revision: string }>> {
    const result = new Map<string, { mtimeMs: number; size: number; revision: string }>();
    for (const dir of target.dirs) {
      for (const file of await this.listCandidates(target.executor, dir)) {
        const info = await target.executor.stat(file);
        if (!info || info.isDirectory) continue;
        const cached = this.states.get(target.key)?.episodes.get(file);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          result.set(file, cached);
          continue;
        }
        const document = await readTextDocument(target.executor, file);
        result.set(file, { mtimeMs: info.mtimeMs, size: info.size, revision: document.revision });
      }
    }
    return result;
  }

  /** 目录下的候选文件：已知配置文件名 + `agents/*.md`。 */
  private async listCandidates(executor: NekConfigHostExecutor, dir: string): Promise<string[]> {
    const files = baselineConfigFiles(dir);
    const entries = await executor.listDir(dir);
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (entry.name === "agents") {
          // 预设目录单独展开（只认 *.md）。
          for (const preset of await executor.listDir(join(dir, "agents"))) {
            if (!preset.isDirectory && preset.name.endsWith(".md")) {
              files.push(join(dir, "agents", preset.name));
            }
          }
        }
        continue;
      }
      if (entry.name.endsWith(".md") && dirBelongsToInstructions(dir))
        files.push(join(dir, entry.name));
    }
    return files;
  }
}

/** `AGENTS.md` 只存在于 agent 目录与项目根目录（不是 `.nek` 下）。 */
function dirBelongsToInstructions(dir: string): boolean {
  return !dir.replaceAll("\\", "/").endsWith("/.nek");
}
