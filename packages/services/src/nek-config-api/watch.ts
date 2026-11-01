/** Shared, reference-counted directory observations for settings and model selection. */
import { join, dirname, normalize } from "node:path";
import type { NekConfigScope } from "@zcode/shared/nek-protocol";
import { baselineConfigFiles } from "./watchFiles.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { ABSENT_REVISION } from "./revision.js";
import { readTextDocument } from "./documents.js";
import { createDirectoryWatch } from "./watchDirectory.js";

export interface NekWatchChange {
  file: string;
  revision: string;
  scope: NekConfigScope;
  error?: { message: string };
}

export interface NekWatchTarget {
  key: string;
  executor: NekConfigHostExecutor;
  local: boolean;
  dirs: Array<{ path: string; scope: NekConfigScope }>;
}

export interface NekWatchHubOptions {
  debounceMs?: number;
  pollSeconds?: number;
  /** Native adapter injection for deterministic lifecycle/error tests. */
  observeDirectory?: typeof createDirectoryWatch;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

interface Observation {
  readonly key: string;
  readonly target: NekWatchTarget;
  readonly path: string;
  readonly scope: NekConfigScope;
  readonly listeners: Set<(change: NekWatchChange) => void>;
  episodes: Map<string, string>;
  epoch: number;
  failure?: string;
  stop(): void;
}

const MAX_DIRECTORIES = 512;
const MAX_SUBSCRIPTIONS = 4096;
const MAX_FILES_PER_DIRECTORY = 512;

export class NekWatchHub {
  private readonly observations = new Map<string, Observation>();
  private subscriptions = 0;
  private disposed = false;

  constructor(private readonly options: NekWatchHubOptions = {}) {}

  /** Each call is a distinct lease, including repeated subscriptions of the same callback. */
  subscribe(target: NekWatchTarget, listener: (change: NekWatchChange) => void): () => void {
    if (this.disposed) throw new Error("nek config watch hub disposed");
    const dirs = new Map(
      target.dirs.map((dir) => [this.directoryKey(target.key, dir.path, dir.scope), dir]),
    );
    const additions = [...dirs.keys()].filter((key) => !this.observations.has(key));
    if (
      this.subscriptions >= MAX_SUBSCRIPTIONS ||
      this.observations.size + additions.length > MAX_DIRECTORIES
    ) {
      throw new Error("nek config watch capacity exceeded");
    }
    const notify = (change: NekWatchChange) => listener(change);
    const leased: Observation[] = [];
    for (const [key, dir] of dirs) {
      let state = this.observations.get(key);
      if (!state) {
        state = {
          key,
          target,
          ...dir,
          listeners: new Set(),
          episodes: new Map(),
          epoch: 0,
          stop: () => undefined,
        };
        this.observations.set(key, state);
        state.listeners.add(notify);
        state.stop = this.start(state);
      } else {
        state.listeners.add(notify);
      }
      leased.push(state);
      if (state.failure !== undefined) {
        try {
          notify({
            file: state.path,
            revision: "watch-error",
            scope: state.scope,
            error: { message: state.failure },
          });
        } catch (error) {
          this.options.logger?.warn("nek config watch listener threw", error);
        }
      }
    }
    this.subscriptions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.disposed) this.subscriptions -= 1;
      for (const state of leased) {
        state.listeners.delete(notify);
        if (state.listeners.size !== 0) continue;
        state.stop();
        this.observations.delete(state.key);
      }
    };
  }

  /** Publication fences scans already in flight; only leases covering this file receive it. */
  publish(
    targetKey: string,
    changes: ReadonlyArray<Omit<NekWatchChange, "scope"> & { scope?: NekConfigScope }>,
  ): void {
    for (const state of this.observations.values()) {
      if (state.target.key !== targetKey) continue;
      for (const change of changes) {
        if (normalize(dirname(change.file)) !== normalize(state.path)) continue;
        state.epoch += 1;
        state.episodes.set(change.file, change.revision);
        this.emit(state, { ...change, scope: state.scope });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.observations.values()) state.stop();
    this.observations.clear();
    this.subscriptions = 0;
  }

  private directoryKey(target: string, path: string, scope: NekConfigScope): string {
    return JSON.stringify([target, normalize(path), scope]);
  }

  private active(state: Observation): boolean {
    return this.observations.get(state.key) === state;
  }

  private emit(state: Observation, change: NekWatchChange): void {
    if (!this.active(state)) return;
    const listeners = Array.from(state.listeners);
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        this.options.logger?.warn("nek config watch listener threw", error);
      }
    }
  }

  private start(state: Observation): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | undefined;
    let requested = 0;
    let completed = 0;
    let priming = true;
    const scan = (): void => {
      requested += 1;
      if (pending) return;
      pending = (async () => {
        while (this.active(state) && completed < requested) {
          const request = requested;
          await this.rescan(state, priming, native?.error);
          priming = false;
          completed = request;
        }
      })().finally(() => {
        pending = undefined;
      });
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        scan();
      }, this.options.debounceMs ?? 200);
      timer.unref?.();
    };
    const native = state.target.local
      ? (this.options.observeDirectory ?? createDirectoryWatch)(state.path, schedule, (error) =>
          this.fail(state, error),
        )
      : undefined;
    // Reconciliation is also what discovers/re-arms missing or atomically replaced directories.
    const poll = setInterval(
      () => {
        native?.refresh();
        scan();
      },
      Math.max(1, this.options.pollSeconds ?? 5) * 1000,
    );
    poll.unref?.();
    scan();
    return () => {
      state.epoch += 1;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      native?.dispose();
    };
  }

  private fail(state: Observation, error: unknown): void {
    if (!this.active(state)) return;
    const message = error instanceof Error ? error.message : String(error);
    state.epoch += 1;
    state.failure = message;
    this.options.logger?.warn("nek config watch failed", state.path, error);
    this.emit(state, {
      file: state.path,
      revision: "watch-error",
      scope: state.scope,
      error: { message },
    });
  }

  private async rescan(
    state: Observation,
    priming: boolean,
    nativeError?: () => unknown,
  ): Promise<void> {
    const epoch = state.epoch;
    try {
      const scanned = await this.scan(state);
      const error = nativeError?.();
      if (error !== undefined) throw error;
      if (!this.active(state)) return;
      if (epoch !== state.epoch) {
        // A publish/native event won while the baseline was being read. Preserve its
        // authoritative revision, and use the rest of the scan only as a baseline.
        if (priming) {
          for (const [file, revision] of scanned) {
            if (!state.episodes.has(file)) state.episodes.set(file, revision);
          }
        }
        return;
      }
      const previous = state.episodes;
      const recovering = state.failure !== undefined;
      state.failure = undefined;
      state.episodes = scanned;
      for (const [file, revision] of scanned) {
        if (!priming && previous.get(file) !== revision)
          this.emit(state, { file, revision, scope: state.scope });
      }
      if (!priming) {
        for (const file of previous.keys()) {
          if (!scanned.has(file))
            this.emit(state, { file, revision: ABSENT_REVISION, scope: state.scope });
        }
      }
      // The first observation closes the subscribe/baseline gap, even for absent files.
      if (priming || recovering)
        this.emit(state, {
          file: state.path,
          revision: priming ? "watch-ready" : "watch-recovered",
          scope: state.scope,
        });
    } catch (error) {
      if (epoch === state.epoch) this.fail(state, error);
    }
  }

  private async scan(state: Observation): Promise<Map<string, string>> {
    const executor = state.target.executor;
    const candidates = new Set(baselineConfigFiles(state.path));
    for (const entry of await executor.listDir(state.path)) {
      if (!entry.isDirectory && entry.name.endsWith(".md"))
        candidates.add(join(state.path, entry.name));
      if (candidates.size > MAX_FILES_PER_DIRECTORY)
        throw new Error("nek config watch file capacity exceeded");
    }
    const result = new Map<string, string>();
    for (const file of candidates) {
      const document = await readTextDocument(executor, file);
      if (document.revision !== ABSENT_REVISION) result.set(file, document.revision);
    }
    return result;
  }
}
