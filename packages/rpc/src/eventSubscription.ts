import { Emitter, toDisposable, type Event, type IDisposable } from "./foundation.js";
import type { IChannelSubscriptionFailure } from "./channels.shared.js";

interface SubscriptionPort<T> {
  id: string;
  channelName: string;
  event: string;
  initialized(): boolean;
  isDisposed(): boolean;
  onDidInitialize: Event<void>;
  retain(subscription: IDisposable): void;
  release(subscription: IDisposable): void;
  listen(onData: (value: T) => void, onError: (error: Error) => void): IDisposable;
  onFailure(failure: IChannelSubscriptionFailure): void;
}

interface FailureCapability {
  failure: IChannelSubscriptionFailure;
  invalidate(): void;
}

type SubscriptionState =
  | { kind: "idle" }
  | { kind: "waiting"; initialization?: IDisposable }
  | { kind: "listening"; request?: IDisposable }
  | { kind: "failed"; capability: FailureCapability }
  | { kind: "disposed" };

/** Revocation severs the UI capability's reference to the connection-owned controller. */
function createFailure(
  detail: Pick<IChannelSubscriptionFailure, "id" | "attempt" | "channelName" | "event" | "error">,
  retry: () => void,
): FailureCapability {
  let command: (() => void) | undefined = retry;
  const invalidated = new Emitter<void>();
  return {
    failure: {
      ...detail,
      isLive: () => command !== undefined,
      retry: () => command?.(),
      onDidInvalidate: invalidated.event,
    },
    invalidate: () => {
      command = undefined;
      invalidated.fire();
      invalidated.dispose();
    },
  };
}

/** Subscriber exceptions are local diagnostics, never a remote stream failure. */
function deliver<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch (error) {
    console.error("[rpc:subscription] listener failed", error);
  }
}

/** One logical subscription, independent registration leases, and one admitted attempt at a time. */
export function createChannelEvent<T>(port: SubscriptionPort<T>): Event<T> {
  const leases = new Set<{ onData: (value: T) => void; onError?: (error: Error) => void }>();
  let state: SubscriptionState = { kind: "idle" };
  let attempt = 0;

  const leave = (next: SubscriptionState): void => {
    const previous = state;
    state = next;
    if (previous.kind === "waiting") previous.initialization?.dispose();
    if (previous.kind === "listening") previous.request?.dispose();
    if (previous.kind === "failed") previous.capability.invalidate();
  };

  const fail = (current: SubscriptionState, error: Error): void => {
    if (state !== current) return;
    const capability = createFailure(
      { id: port.id, attempt, channelName: port.channelName, event: port.event, error },
      () => {
        if (state.kind !== "failed" || state.capability !== capability) return;
        leave({ kind: "idle" });
        start();
      },
    );
    leave({ kind: "failed", capability });
    port.onFailure(capability.failure);
    for (const lease of Array.from(leases)) {
      if (lease.onError) deliver(lease.onError, error);
    }
  };

  const send = (): void => {
    const current: SubscriptionState = { kind: "listening" };
    state = current;
    attempt += 1;
    const request = port.listen(
      (value) => {
        if (state !== current) return;
        for (const lease of Array.from(leases)) deliver(lease.onData, value);
      },
      (error) => fail(current, error),
    );
    // Synchronous replies may have failed or disposed the attempt before listen returns.
    if (state === current) current.request = request;
    else request.dispose();
  };

  const start = (): void => {
    if (state.kind !== "idle" || leases.size === 0) return;
    if (port.initialized()) {
      send();
      return;
    }
    const waiting: SubscriptionState = { kind: "waiting" };
    state = waiting;
    waiting.initialization = port.onDidInitialize(() => {
      if (state !== waiting) return;
      leave({ kind: "idle" });
      // Initialization and disposal can share a tick; only the current waiting lease admits send.
      queueMicrotask(() => {
        if (state.kind === "idle") start();
      });
    });
  };

  const subscription = toDisposable(() => {
    leave({ kind: "disposed" });
    leases.clear();
    port.release(subscription);
  });

  return (onData, onError) => {
    if (state.kind === "disposed" || port.isDisposed()) return toDisposable(() => undefined);
    const lease = { onData, onError };
    leases.add(lease);
    if (leases.size === 1) {
      port.retain(subscription);
      start();
    }
    return toDisposable(() => {
      if (!leases.delete(lease) || leases.size > 0) return;
      if (state.kind !== "disposed") leave({ kind: "idle" });
      port.release(subscription);
    });
  };
}
