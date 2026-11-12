import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  NekModelRuntimeHandle,
  NekModelRuntimeLease,
  NekReloadResult,
} from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "./hostExecutor.js";

const MAX_WRITERS = 128;
const MAX_PENDING = 16;
const MAX_MODELS_BYTES = 4 * 1024 * 1024;

/** Content, not mtime/model ID, fences same-ID endpoint changes and watcher debounce races. */
export async function modelRuntimeFingerprint(executor: NekConfigHostExecutor): Promise<string> {
  const path = join(executor.agentDir(), "models.json");
  const stat = await executor.stat(path);
  if (stat && stat.size > MAX_MODELS_BYTES) throw new Error("models.json exceeds 4 MB");
  const text = await executor.readFile(path);
  if (text === null) return "absent";
  if (Buffer.byteLength(text) > MAX_MODELS_BYTES) throw new Error("models.json exceeds 4 MB");
  return createHash("sha256").update(text).digest("hex");
}

type ModelRefreshResult = NekReloadResult & { changed: boolean };

export interface NekLiveModelRuntime extends NekModelRuntimeLease {
  readonly handle: NekModelRuntimeHandle;
  refresh(): Promise<ModelRefreshResult>;
}

/** Only live process leases are retained. No model catalog or accepted input lives here. */
export class NekModelRuntimeOwner {
  private readonly writers = new Set<NekLiveModelRuntime>();
  private disposed = false;

  register(
    options: {
      handle: NekModelRuntimeHandle;
      fingerprint: () => Promise<string>;
      release: () => void;
      diagnostics?: (result: NekReloadResult) => void;
    },
    registration: { initialFingerprint?: string } = {},
  ): NekLiveModelRuntime {
    if (this.disposed) throw new Error("nek model runtime disposed");
    if (this.writers.size >= MAX_WRITERS) throw new Error("nek model runtime capacity exceeded");
    const { handle, fingerprint } = options;
    let active = true;
    // A freshly spawned process already loaded this exact content; seeding it removes a
    // redundant reload that otherwise dominates the first model read after each spawn.
    let applied: string | undefined = registration.initialFingerprint;
    let pending = 0;
    let needsRebind = false;
    let tail = Promise.resolve();
    let refreshing: Promise<ModelRefreshResult> | undefined;
    let reloading: Promise<NekReloadResult> | undefined;
    const assertLive = () => {
      if (!active || this.disposed || !handle.isWritable())
        throw new Error("nek model runtime process changed or closed; retry the operation");
    };
    const serialize = async <T>(run: () => Promise<T>): Promise<T> => {
      assertLive();
      if (pending >= MAX_PENDING)
        return Promise.reject(new Error("nek model admission capacity exceeded; retry"));
      pending += 1;
      const result = tail.then(async () => {
        assertLive();
        return await run();
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pending -= 1;
      });
    };
    const ensure = async (force = false): Promise<ModelRefreshResult> => {
      let result: ModelRefreshResult = { changed: false, deferred: false, diagnostics: [] };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assertLive();
        const before = await fingerprint();
        assertLive();
        if (!force && before === applied) return result;
        // A failed/deferred/diagnostic reload can never certify even an older fingerprint.
        applied = undefined;
        needsRebind = true;
        result = { ...(await handle.reload()), changed: true };
        assertLive();
        if (result.deferred) return result;
        if (result.diagnostics.some((item) => item.severity === "error")) return result;
        const after = await fingerprint();
        assertLive();
        if (before === after) {
          applied = after;
          return result;
        }
        force = false;
      }
      throw new Error("nek model configuration kept changing during reload; retry the operation");
    };
    const lease: NekLiveModelRuntime = {
      handle,
      run: (kind, command) =>
        serialize(async () => {
          const result = await ensure();
          if (result.diagnostics.length) options.diagnostics?.(result);
          const errors = result.diagnostics.filter((item) => item.severity === "error");
          if (errors.length)
            throw new Error(
              `nek model configuration reload failed: ${errors.map((item) => item.message).join("; ")}`,
            );
          // `deferred` is nek's "apply after this turn" answer, not a failure: the running turn
          // keeps its own config either way, and blocking would also block the very steer /
          // follow-up that is meant to land in that turn. `applied` stays unset (and
          // `needsRebind` set), so the next command after the turn settles reloads and rebinds.
          if (kind === "input" && needsRebind && !result.deferred) {
            await handle.rebindModel();
            assertLive();
            // Rebinding is asynchronous; a concurrent edit must not slip into this prompt.
            if ((await fingerprint()) !== applied)
              throw new Error("nek model configuration changed before input; retry the operation");
          }
          assertLive();
          // No await between the final identity check and the actual RPC submission.
          const value = await command();
          if (!result.deferred && (kind === "input" || value != null)) needsRebind = false;
          return value;
        }),
      reload: () => {
        if (!reloading)
          reloading = serialize(() => ensure(true)).finally(() => {
            reloading = undefined;
          });
        return reloading;
      },
      refresh: () => {
        if (!refreshing)
          refreshing = serialize(() => ensure()).finally(() => {
            refreshing = undefined;
          });
        return refreshing;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        applied = undefined;
        this.writers.delete(lease);
        options.release();
      },
    };
    this.writers.add(lease);
    return lease;
  }

  dispose(): void {
    this.disposed = true;
    for (const writer of this.writers) writer.dispose();
  }
}
