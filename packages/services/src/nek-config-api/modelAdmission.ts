import type { NekModelReadContext } from "@zcode/shared/nek-protocol";
import { assertModelRead, waitForModelRead } from "./modelReadLifetime.js";

interface Admission {
  start(): void;
  cancel(error: unknown): void;
}

/** Removable FIFO: cancellation before execution releases capacity and never submits an RPC. */
export class NekModelAdmission {
  private readonly queue: Admission[] = [];
  private active = false;
  private disposed = false;

  run<T>(run: () => Promise<T>, context?: NekModelReadContext): Promise<T> {
    assertModelRead(context);
    if (this.disposed) return Promise.reject(new Error("nek model admission disposed"));
    if (this.queue.length + Number(this.active) >= 16)
      return Promise.reject(new Error("nek model admission capacity exceeded; retry"));
    context?.stage?.("queue");
    const work = new Promise<T>((resolve, reject) => {
      const signal = context?.signal;
      const detach = () => signal?.removeEventListener("abort", abort);
      const entry: Admission = {
        cancel: (error) => {
          detach();
          reject(error);
        },
        start: () => {
          detach();
          this.active = true;
          void Promise.resolve()
            .then(() => {
              assertModelRead(context);
              if (this.disposed) throw new Error("nek model admission disposed");
              return run();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active = false;
              this.queue.shift()?.start();
            });
        },
      };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        entry.cancel(signal?.reason);
      };
      if (!this.active) entry.start();
      else {
        this.queue.push(entry);
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
    return waitForModelRead(work, context);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.queue.splice(0))
      entry.cancel(new Error("nek model admission disposed"));
  }
}
