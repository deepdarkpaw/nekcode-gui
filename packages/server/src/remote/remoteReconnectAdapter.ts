import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import { RemoteReconnectStateMachine, type RemoteReconnectState } from "./reconnectStateMachine.js";

export interface RemoteReconnectStatusAdapterOptions {
  connectionId: string;
  machine: RemoteReconnectStateMachine;
  emit: (event: RemoteConnectionStatusEvent) => void;
  /** Set false when the consumer already has the machine's current state. */
  emitInitialState?: boolean;
}

export function toRemoteConnectionStatusEvent(
  connectionId: string,
  state: RemoteReconnectState,
): RemoteConnectionStatusEvent {
  switch (state.kind) {
    case "connected":
      return { connectionId, kind: "connected" };
    case "disconnected":
      return { connectionId, kind: "disconnected" };
    case "reconnecting":
      return {
        connectionId,
        kind: "reconnecting",
        attempt: state.attempt,
        max: state.max,
        nextDelayMs: state.nextDelayMs,
      };
    case "failed":
      return { connectionId, kind: "failed", message: state.error.message };
    case "cancelled":
      return { connectionId, kind: "cancelled" };
  }
}

/** Projects the state machine's domain state into the renderer status contract. */
export class RemoteReconnectStatusAdapter {
  private readonly connectionId: string;
  private readonly machine: RemoteReconnectStateMachine;
  private readonly emit: (event: RemoteConnectionStatusEvent) => void;
  private readonly subscription: { dispose(): void };
  private lastEvent: RemoteConnectionStatusEvent;
  private disposed = false;

  constructor(options: RemoteReconnectStatusAdapterOptions) {
    this.connectionId = options.connectionId;
    this.machine = options.machine;
    this.emit = options.emit;
    this.lastEvent = toRemoteConnectionStatusEvent(this.connectionId, options.machine.state);
    this.subscription = options.machine.onStateChange((state) => this.handleState(state));
    if (options.emitInitialState ?? true) this.emit(this.lastEvent);
  }

  retryNow(): void {
    if (this.machine.state.kind === "connected") return;
    this.machine.retryNow();
  }

  cancelReconnect(): void {
    if (this.machine.state.kind === "connected") return;
    this.machine.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
  }

  private handleState(state: RemoteReconnectState): void {
    if (this.disposed) return;
    const event = toRemoteConnectionStatusEvent(this.connectionId, state);
    if (areStatusEventsEqual(this.lastEvent, event)) return;
    this.lastEvent = event;
    this.emit(event);
  }
}

function areStatusEventsEqual(
  left: RemoteConnectionStatusEvent,
  right: RemoteConnectionStatusEvent,
): boolean {
  if (left.connectionId !== right.connectionId || left.kind !== right.kind) return false;
  if (left.kind !== "reconnecting" || right.kind !== "reconnecting") {
    return left.kind === "failed" && right.kind === "failed"
      ? left.message === right.message
      : true;
  }
  return (
    left.attempt === right.attempt &&
    left.max === right.max &&
    left.nextDelayMs === right.nextDelayMs
  );
}

export function createRemoteReconnectStatusAdapter(
  options: RemoteReconnectStatusAdapterOptions,
): RemoteReconnectStatusAdapter {
  return new RemoteReconnectStatusAdapter(options);
}
