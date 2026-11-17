import type {
  NekModelReadContext,
  NekModelRuntimeLease,
  NekRpcCommand,
} from "@zcode/shared/nek-protocol";
import { assertModelRead, NekModelReadBudget, waitForModelRead } from "./modelReadLifetime.js";
import type { NekControlClient } from "./control.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { modelRuntimeFingerprint } from "./modelRuntime.js";

/** Freshness gates every model-dependent command; only readonly catalog calls share a flight. */
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
    call: ((command: NekRpcCommand, context?: NekModelReadContext) => {
      const call = () => client.call(command, context);
      if (command.type === "get_available_models" || command.type === "get_model_catalog")
        return reads.run(
          command,
          (shared) =>
            lease.run(
              "selection",
              () => {
                shared.stage?.("facts");
                return client.call(command, shared);
              },
              shared,
            ),
          context,
        );
      // Explicit probes must see current models.json, but each click is its own request.
      if (command.type === "fetch_provider_models" || command.type === "test_provider")
        return lease.run("selection", call, context);
      if (command.type === "auth_status" && context)
        return lease.run(
          "selection",
          () => {
            context.stage?.("facts");
            return call();
          },
          context,
        );
      if (command.type === "reload") {
        reads.invalidate();
        return lease.reload(context);
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
  private readonly flights = new Map<
    string,
    { promise: Promise<unknown>; budget: NekModelReadBudget; waiters: number }
  >();
  private generation = 0;
  private disposed = false;

  constructor(private readonly executor: NekConfigHostExecutor) {}

  /** Reload/auth changes retire the read generation even when models.json bytes did not change. */
  invalidate(): void {
    this.generation += 1;
  }

  async run<T>(
    command: ModelReadCommand,
    read: (context: NekModelReadContext) => Promise<T>,
    context?: NekModelReadContext,
  ): Promise<T> {
    assertModelRead(context);
    if (this.disposed) throw new Error("nek model reads disposed");
    const generation = this.generation;
    const fingerprint = await waitForModelRead(modelRuntimeFingerprint(this.executor), context);
    assertModelRead(context);
    if (this.disposed) throw new Error("nek model reads disposed");
    const key = JSON.stringify([generation, fingerprint, command]);
    let flight = this.flights.get(key);
    if (!flight) {
      if (this.flights.size >= MAX_READ_FLIGHTS)
        throw new Error("nek model read capacity exceeded; retry the read");
      // Shared work has its own deadline, not the cancellation signal of its first consumer.
      const remaining =
        context?.deadline === undefined ? undefined : Math.max(0, context.deadline - Date.now());
      const budget = new NekModelReadBudget(remaining, {
        deadline: context?.deadline,
        stage: context?.stage,
      });
      flight = { promise: Promise.resolve(), budget, waiters: 0 };
      const owned = flight;
      owned.promise = waitForModelRead(
        Promise.resolve().then(() => {
          assertModelRead(budget.context);
          return read(budget.context);
        }),
        budget.context,
      )
        .then((result) => {
          if (this.disposed) throw new Error("nek model reads disposed");
          assertModelRead(budget.context);
          return result;
        })
        .finally(() => {
          budget.finish();
          if (this.flights.get(key) === owned) this.flights.delete(key);
        });
      this.flights.set(key, owned);
    }
    if (flight.waiters >= 1024) throw new Error("nek model read waiter capacity exceeded; retry");
    flight.waiters += 1;
    try {
      return (await waitForModelRead(flight.promise, context)) as T;
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0) {
        flight.budget.abort();
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const flight of this.flights.values())
      flight.budget.abort(new Error("nek model reads disposed"));
    this.flights.clear();
  }
}
