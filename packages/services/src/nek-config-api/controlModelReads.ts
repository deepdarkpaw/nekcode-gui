import type { NekModelRuntimeLease, NekRpcCommand } from "@zcode/shared/nek-protocol";
import type { NekControlClient } from "./control.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { modelRuntimeFingerprint } from "./modelRuntime.js";

/** Preserve the control contract while sharing only model reads behind the freshness lease. */
export function withModelReadAdmission(
  client: NekControlClient,
  lease: NekModelRuntimeLease,
  reads: NekControlModelReads,
): NekControlClient {
  return {
    onAuthEvent: (listener) => client.onAuthEvent(listener),
    respondExtensionUi: (response) => client.respondExtensionUi(response),
    setStructuredHandler: (handler) => client.setStructuredHandler(handler),
    close: () => client.close(),
    call: ((command: NekRpcCommand) => {
      const call = () => client.call(command);
      if (command.type === "get_available_models" || command.type === "get_model_catalog")
        return reads.run(command, () => lease.run("selection", call));
      if (command.type === "reload") {
        reads.invalidate();
        return lease.reload();
      }
      if (command.type === "auth_login" || command.type === "auth_logout") {
        reads.invalidate();
        return call().finally(() => reads.invalidate());
      }
      return call();
    }) as NekControlClient["call"],
  };
}

const MAX_READ_FLIGHTS = 16;
type ModelReadCommand =
  | { type: "get_available_models" }
  | { type: "get_model_catalog"; provider?: string; ids?: string[] };

/** Coalesce identical readonly model RPCs, never selections/inputs or settled results. */
export class NekControlModelReads {
  private readonly flights = new Map<string, Promise<unknown>>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly executor: NekConfigHostExecutor) {}

  /** Reload/auth changes retire the read generation even when models.json bytes did not change. */
  invalidate(): void {
    this.generation += 1;
  }

  async run<T>(command: ModelReadCommand, read: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("nek model reads disposed");
    const generation = this.generation;
    const fingerprint = await modelRuntimeFingerprint(this.executor);
    if (this.disposed) throw new Error("nek model reads disposed");
    const key = JSON.stringify([generation, fingerprint, command]);
    const existing = this.flights.get(key);
    if (existing) return (await existing) as T;
    if (this.flights.size >= MAX_READ_FLIGHTS)
      throw new Error("nek model read capacity exceeded; retry the read");
    const pending = Promise.resolve()
      .then(read)
      .then((result) => {
        if (this.disposed) throw new Error("nek model reads disposed");
        return result;
      })
      .finally(() => {
        if (this.flights.get(key) === pending) this.flights.delete(key);
      });
    this.flights.set(key, pending);
    return await pending;
  }

  dispose(): void {
    this.disposed = true;
    this.flights.clear();
  }
}
