import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  NekModelReadContext,
  NekModelRuntimeHandle,
  NekModelRuntimeLease,
  NekReloadResult,
} from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { NekModelAdmission } from "./modelAdmission.js";
import { assertModelRead, waitForModelRead } from "./modelReadLifetime.js";

const MAX_WRITERS = 128;
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
  refresh(context?: NekModelReadContext): Promise<ModelRefreshResult>;
  invalidate(): void;
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
    let needsRebind = false;
    let invalidation = 0;
    let dirty = false;
    const admission = new NekModelAdmission();
    const lifetime = new AbortController();
    const readContext = (context?: NekModelReadContext): NekModelReadContext => ({
      ...context,
      signal: context?.signal
        ? AbortSignal.any([lifetime.signal, context.signal])
        : lifetime.signal,
    });
    let refreshing: Promise<ModelRefreshResult> | undefined;
    let reloading: Promise<NekReloadResult> | undefined;
    const assertLive = () => {
      if (!active || this.disposed || !handle.isWritable())
        throw new Error("nek model runtime process changed or closed; retry the operation");
    };
    const serialize = async <T>(
      run: () => Promise<T>,
      context?: NekModelReadContext,
    ): Promise<T> => {
      assertLive();
      return admission.run(run, context);
    };
    const ensure = async (
      force = false,
      context?: NekModelReadContext,
    ): Promise<ModelRefreshResult> => {
      let result: ModelRefreshResult = { changed: false, deferred: false, diagnostics: [] };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assertLive();
        assertModelRead(context);
        const generation = invalidation;
        const before = await waitForModelRead(fingerprint(), context);
        assertLive();
        assertModelRead(context);
        if (!force && !dirty && before === applied) return result;
        dirty = false;
        // A failed/deferred/diagnostic reload can never certify even an older fingerprint.
        applied = undefined;
        needsRebind = true;
        context?.stage?.("reload");
        result = { ...(await waitForModelRead(handle.reload(context), context)), changed: true };
        assertLive();
        assertModelRead(context);
        if (result.deferred) return result;
        if (result.diagnostics.some((item) => item.severity === "error")) return result;
        const after = await waitForModelRead(fingerprint(), context);
        assertLive();
        assertModelRead(context);
        if (before === after && generation === invalidation) {
          applied = after;
          return result;
        }
        force = false;
      }
      throw new Error("nek model configuration kept changing during reload; retry the operation");
    };
    const lease: NekLiveModelRuntime = {
      handle,
      invalidate: () => {
        if (!dirty) invalidation += 1;
        dirty = true;
      },
      run: (kind, command, caller) => {
        const context = readContext(caller);
        return serialize(async () => {
          const result = await ensure(false, context);
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
          assertModelRead(context);
          const value = await waitForModelRead(command(), context);
          assertLive();
          assertModelRead(context);
          if (!result.deferred && (kind === "input" || value != null)) needsRebind = false;
          return value;
        }, context);
      },
      reload: (caller) => {
        const context = readContext(caller);
        if (caller) return serialize(() => ensure(true, context), context);
        if (!reloading)
          reloading = serialize(() => ensure(true, context), context).finally(() => {
            reloading = undefined;
          });
        return reloading;
      },
      refresh: (caller) => {
        const context = readContext(caller);
        if (caller) return serialize(() => ensure(false, context), context);
        if (!refreshing)
          refreshing = serialize(() => ensure(false, context), context).finally(() => {
            refreshing = undefined;
          });
        return refreshing;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        lifetime.abort(new Error("nek model runtime process changed or disposed; retry"));
        admission.dispose();
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
