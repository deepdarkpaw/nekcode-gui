import { basename } from "node:path";
import type { NekConfigTarget, NekModelReadContext } from "@zcode/shared/nek-protocol";
import { createNekControlClient, type NekControlClient } from "./control.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import type { NekModelRuntimeOwner, NekLiveModelRuntime } from "./modelRuntime.js";
import { openManagedControl } from "./managedControl.js";
import { NekModelReadBudget, assertModelRead, waitForModelRead } from "./modelReadLifetime.js";
import {
  targetKeyOf,
  type NekConfigApiOptions,
  type NekReloadOutcome,
  type NekTargetContext,
} from "./runtime.js";
import type { NekWatchChange } from "./watch.js";

interface Control {
  executor: NekConfigHostExecutor;
  promise: Promise<NekControlClient>;
  startup?: NekModelReadBudget;
  lease?: NekLiveModelRuntime;
  stop?: () => void;
  active: boolean;
}

/** Releasing a retiring control is idempotent across timeout, abort and late factory failure. */
function stopControlWatch(control: Control): void {
  const stop = control.stop;
  control.stop = undefined;
  stop?.();
}

/** Runtime-owned control identities and freshness; no settled facts or live-session reloads. */
export class NekModelControls {
  private readonly controls = new Map<string, Control>();
  private readonly retiring = new Map<string, Control>();
  private disposed = false;

  constructor(
    private readonly options: {
      config: NekConfigApiOptions;
      target: (target: NekConfigTarget) => NekTargetContext;
      owner: NekModelRuntimeOwner;
      watch: (target: NekConfigTarget, listener: (change: NekWatchChange) => void) => () => void;
      report: (target: NekConfigTarget, result: NekReloadOutcome) => void;
    },
  ) {}

  async get(target: NekConfigTarget, read?: NekModelReadContext): Promise<NekControlClient> {
    assertModelRead(read);
    if (this.disposed) throw new Error("nek control disposed");
    read?.stage?.("control-start");
    const context = this.options.target(target);
    const previous = this.controls.get(context.key);
    if (previous && previous.executor !== context.executor)
      void this.abort(target).catch((error) =>
        this.options.config.logger?.warn("retired control close failed", error),
      );
    if (this.retiring.has(context.key)) throw new Error("nek control startup retiring; retry");
    let control = this.controls.get(context.key);
    if (!control) control = this.open(target, context);
    assertModelRead(control.startup?.context);
    const startupSignal = control.startup?.context.signal;
    const wait = startupSignal
      ? {
          ...read,
          signal: read?.signal ? AbortSignal.any([read.signal, startupSignal]) : startupSignal,
        }
      : read;
    const client = await waitForModelRead(control.promise, wait);
    assertModelRead(read);
    if (!control.active || this.options.config.hosts.executor(target) !== control.executor)
      throw new Error("nek control target changed; retry");
    read?.stage?.("control-ready");
    return client;
  }

  has(target: NekConfigTarget): boolean {
    return this.controls.has(targetKeyOf(target));
  }

  async refreshContent(target: NekConfigTarget, context?: NekModelReadContext) {
    await this.get(target, context);
    const lease = this.controls.get(targetKeyOf(target))?.lease;
    if (!lease) throw new Error("nek control model lease retired; retry");
    return await lease.refresh(context);
  }

  async refresh(target: NekConfigTarget, context?: NekModelReadContext): Promise<NekReloadOutcome> {
    const result = await this.refreshContent(target, context);
    return {
      reloaded: result.changed && !result.deferred ? 1 : 0,
      deferred: Number(result.deferred),
      diagnostics: result.diagnostics,
      failures: [],
    };
  }

  async abort(target: NekConfigTarget): Promise<void> {
    const key = targetKeyOf(target);
    const control = this.controls.get(key);
    if (!control) return;
    this.controls.delete(key);
    control.active = false;
    if (control.startup) {
      // Non-interruptible locator/executor ports retain one tombstone, not an abandoned start
      // per retry. A late client is closed by openManagedControl before it can register.
      this.retiring.set(key, control);
      control.startup.abort(new Error("nek control replaced or disposed"));
    }
    stopControlWatch(control);
    control.lease?.dispose();
    await (await control.promise.catch(() => undefined))?.close();
  }

  dispose(): void {
    this.disposed = true;
    for (const [key, control] of this.controls) {
      control.active = false;
      control.startup?.abort(new Error("nek config runtime disposed"));
      stopControlWatch(control);
      control.lease?.dispose();
      void control.promise.then((client) => client.close()).catch(() => undefined);
      this.controls.delete(key);
    }
  }

  private open(target: NekConfigTarget, context: NekTargetContext): Control {
    if (this.controls.size + this.retiring.size >= 128)
      throw new Error("nek control capacity exceeded");
    const budget = new NekModelReadBudget(this.options.config.config?.modelReadMs);
    let control!: Control;
    let dirty = false;
    const current = () =>
      !this.disposed &&
      control.active &&
      this.controls.get(context.key) === control &&
      this.options.config.hosts.executor(target) === control.executor;
    const promise = openManagedControl({
      read: budget.context,
      target,
      context,
      factory: this.options.config.control ?? createNekControlClient,
      logger: this.options.config.logger,
      register: (options, registration) => this.options.owner.register(options, registration),
      setLease: (lease) => {
        control.lease = lease;
        if (dirty) lease?.invalidate();
      },
      report: (result) => this.options.report(target, result),
      isCurrent: current,
    }).finally(() => {
      budget.finish();
      control.startup = undefined;
      if (this.retiring.get(context.key) === control) this.retiring.delete(context.key);
    });
    control = { executor: context.executor, promise, startup: budget, active: true };
    this.controls.set(context.key, control);
    try {
      control.stop = this.options.watch(target, (change) => {
        const name = basename(change.file);
        if (change.scope !== "global" || (name !== "auth.json" && name !== "settings.json")) return;
        dirty = true;
        control.lease?.invalidate();
      });
    } catch (error) {
      control.active = false;
      budget.abort(error);
    }
    const retire = () => {
      control.active = false;
      stopControlWatch(control);
    };
    const signal = budget.context.signal!;
    if (signal.aborted) retire();
    else signal.addEventListener("abort", retire, { once: true });
    void control.promise
      .finally(() => signal.removeEventListener("abort", retire))
      .catch(() => {
        if (this.controls.get(context.key) !== control) return;
        this.controls.delete(context.key);
        stopControlWatch(control);
      });
    return control;
  }
}
