import { basename } from "node:path";
import type { NekConfigTarget, NekModelRuntimeFreshness } from "@zcode/shared/nek-protocol";
import type { NekConfigSessionHandle, NekReloadOutcome, NekTargetContext } from "./runtime.js";
import type { NekWatchChange } from "./watch.js";
import {
  modelRuntimeFingerprint,
  NekModelRuntimeOwner,
  type NekLiveModelRuntime,
} from "./modelRuntime.js";

/** Ref-counted target watches follow live writer leases, not UI windows or disk sessions. */
export class NekLiveModelRuntimes {
  readonly owner = new NekModelRuntimeOwner();
  private readonly targets = new Map<string, { writers: Set<NekLiveModelRuntime>; stop(): void }>();

  constructor(
    private readonly options: {
      watch(target: NekConfigTarget, listener: (change: NekWatchChange) => void): () => void;
      report(target: NekConfigTarget, result: NekReloadOutcome): void;
      warn(...args: unknown[]): void;
    },
  ) {}

  forTarget(context: NekTargetContext): NekModelRuntimeFreshness {
    return {
      register: (handle, registration) => {
        let scope = this.targets.get(context.key);
        if (!scope) {
          scope = { writers: new Set(), stop: () => undefined };
          const owned = scope;
          this.targets.set(context.key, scope);
          try {
            scope.stop = this.options.watch(context.target, (change) => {
              if (this.targets.get(context.key) !== owned) return;
              if (change.error) {
                this.reportFailure(context.target, "runtime", change.error.message);
                return;
              }
              if (basename(change.file) !== "models.json") return;
              for (const writer of owned.writers) {
                void writer
                  .refresh()
                  .then((result) => {
                    if (result.changed)
                      this.options.report(context.target, {
                        reloaded: result.deferred ? 0 : 1,
                        deferred: result.deferred ? 1 : 0,
                        diagnostics: result.diagnostics,
                        failures: [],
                      });
                  })
                  .catch((error: unknown) => {
                    this.options.warn("model runtime refresh failed", error);
                    this.reportFailure(
                      context.target,
                      writer.handle.sessionKey,
                      error instanceof Error ? error.message : String(error),
                    );
                  });
              }
            });
          } catch (error) {
            this.targets.delete(context.key);
            throw error;
          }
        }
        const owned = scope;
        try {
          const writer = this.owner.register(
            {
              handle,
              fingerprint: () => modelRuntimeFingerprint(context.executor),
              diagnostics: (result) =>
                this.options.report(context.target, {
                  reloaded: result.deferred ? 0 : 1,
                  deferred: result.deferred ? 1 : 0,
                  diagnostics: result.diagnostics,
                  failures: [],
                }),
              release: () => {
                owned.writers.delete(writer);
                if (owned.writers.size) return;
                owned.stop();
                this.targets.delete(context.key);
              },
            },
            registration,
          );
          owned.writers.add(writer);
          return writer;
        } catch (error) {
          if (!owned.writers.size) {
            owned.stop();
            this.targets.delete(context.key);
          }
          throw error;
        }
      },
    };
  }

  sessions(key: string): NekConfigSessionHandle[] {
    return [...(this.targets.get(key)?.writers ?? [])]
      .filter((writer) => writer.handle.isWritable())
      .map((writer) => ({
        sessionKey: writer.handle.sessionKey,
        cwd: writer.handle.cwd,
        busy: false,
        refreshModels: () => writer.refresh(),
        call: ((command) =>
          command.type === "reload"
            ? writer.reload()
            : writer.handle.call(command)) as NekConfigSessionHandle["call"],
      }));
  }

  dispose(): void {
    this.owner.dispose();
  }

  private reportFailure(target: NekConfigTarget, sessionKey: string, message: string): void {
    this.options.report(target, {
      reloaded: 0,
      deferred: 0,
      diagnostics: [],
      failures: [{ sessionKey, message }],
    });
  }
}
