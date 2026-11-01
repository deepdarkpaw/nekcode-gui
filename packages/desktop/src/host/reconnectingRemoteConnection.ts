import { buildSshRemoteHostKey, type RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import { RemoteReconnectStateMachine, type ReconnectClock } from "@zcode/server/remote/reconnectStateMachine.js";
import { RemoteReconnectStatusAdapter } from "@zcode/server/remote/remoteReconnectAdapter.js";
import type { WindowRemoteConnectionHandle } from "./windowRemoteConnectionRegistry.js";

export interface RemoteReconnectControls {
  retryNow(): void;
  cancelReconnect(): void;
  dispose(): void;
}

/** One physical SSH entry owns one machine; logical workspaces read the current handle. */
export async function createReconnectingRemoteConnection<TServices, TCapabilities>(options: {
  target: RemoteTarget;
  signal: AbortSignal;
  backoffSeconds: readonly number[];
  connect(signal: AbortSignal): Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  emit(event: RemoteConnectionStatusEvent): void;
  attachReconnectAdapter(connectionId: string, adapter: RemoteReconnectControls): () => void;
  clock?: ReconnectClock;
}): Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>> {
  if (options.target.kind !== "ssh") return options.connect(options.signal);
  const connectionId = buildSshRemoteHostKey(options.target);
  let current = await options.connect(options.signal);
  let available = true;
  let disposed = false;
  let attemptController: AbortController | undefined;
  let closeSubscription: { dispose(): void } | undefined;
  let retirement: Promise<void> = Promise.resolve();
  const retire = () => {
    closeSubscription?.dispose();
    closeSubscription = undefined;
    available = false;
    const retired = current;
    retirement = retirement.then(() => retired.dispose());
    void retirement.catch(() => undefined);
    return retirement;
  };
  const machine = new RemoteReconnectStateMachine({
    backoffSeconds: options.backoffSeconds,
    clock: options.clock,
    onStateChange: (state) => {
      if (state.kind !== "reconnecting" && state.kind !== "cancelled") return;
      attemptController?.abort();
    },
    connect: async () => {
      const controller = new AbortController();
      attemptController = controller;
      await retirement;
      if (disposed || controller.signal.aborted) throw new Error("remote reconnect cancelled");
      const candidate = await options.connect(controller.signal);
      if (disposed || controller.signal.aborted) {
        await candidate.dispose();
        throw new Error("remote reconnect cancelled");
      }
      current = candidate;
      available = true;
      subscribe();
    },
  });
  const subscribe = () => {
    closeSubscription = current.onDidClose?.((event) => {
      if (disposed || !available) return;
      void retire();
      machine.markDisconnected(event.error ?? new Error(`SSH connection closed (${event.exitCode})`));
    });
  };
  const adapter = new RemoteReconnectStatusAdapter({ connectionId, machine, emit: options.emit });
  const detach = options.attachReconnectAdapter(connectionId, adapter);
  subscribe();
  const abort = () => {
    machine.cancel();
    attemptController?.abort();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return {
    get services() {
      if (!available || disposed) throw new Error("remote SSH connection is not connected");
      return current.services;
    },
    get capabilities() {
      if (!available || disposed) throw new Error("remote SSH connection is not connected");
      return current.capabilities;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abort();
      options.signal.removeEventListener("abort", abort);
      detach();
      adapter.dispose();
      if (available) await retire();
      else await retirement;
    },
  };
}
