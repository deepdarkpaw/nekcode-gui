import type { NekModelReadContext } from "@zcode/shared/nek-protocol";

export const DEFAULT_MODEL_READ_MS = 15_000;

/** A stage is diagnostic metadata, never a command body or provider response. */
class NekModelReadTimeoutError extends Error {
  readonly code = "MODEL_READ_TIMEOUT";
  constructor(readonly stage: string) {
    super(`nek model read deadline exceeded at ${stage}; retry the read`);
    this.name = "NekModelReadTimeoutError";
  }
}

export function assertModelRead(context?: NekModelReadContext): void {
  context?.signal?.throwIfAborted();
  if (context?.deadline !== undefined && Date.now() >= context.deadline)
    throw new NekModelReadTimeoutError("admission");
}

/** Detach only this waiter. The work owner must propagate cancellation to queued/RPC work. */
export function waitForModelRead<T>(work: Promise<T>, context?: NekModelReadContext): Promise<T> {
  try {
    assertModelRead(context);
  } catch (error) {
    void work.catch(() => undefined);
    return Promise.reject(error);
  }
  const signal = context?.signal;
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** One absolute deadline spans locate/start, queue, reload, facts and dirty follow-up. */
export class NekModelReadBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly started = Date.now();
  private current = "start";
  private readonly timings: Record<string, number> = {
    start: 0,
    "control-ready": 0,
    queue: 0,
    reload: 0,
    facts: 0,
  };
  readonly context: NekModelReadContext;
  private readonly detach: () => void;

  constructor(timeoutMs = DEFAULT_MODEL_READ_MS, parent?: NekModelReadContext) {
    const deadline = Math.min(this.started + timeoutMs, parent?.deadline ?? Infinity);
    const abort = () => this.abort(parent?.signal?.reason);
    parent?.signal?.addEventListener("abort", abort, { once: true });
    this.detach = () => parent?.signal?.removeEventListener("abort", abort);
    this.context = {
      signal: this.controller.signal,
      deadline,
      stage: (stage) => {
        this.current = stage;
        this.timings[stage] = Date.now() - this.started;
        parent?.stage?.(stage);
      },
    };
    this.timer = setTimeout(
      () => this.abort(new NekModelReadTimeoutError(this.current)),
      Math.max(0, deadline - Date.now()),
    );
    if (parent?.signal?.aborted) abort();
  }

  abort(reason: unknown = new Error("nek model read cancelled")): void {
    this.controller.abort(reason);
  }

  finish(): Readonly<Record<string, number>> {
    clearTimeout(this.timer);
    this.detach();
    this.timings.finish = Date.now() - this.started;
    return this.timings;
  }
}
