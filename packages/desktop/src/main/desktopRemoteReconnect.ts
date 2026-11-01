import {
  buildSshRemoteHostKey,
  remoteDesktopMessageSchema,
  type RemoteTarget,
} from "@zcode/shared";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import { NekRemoteInteractionHostService } from "./desktopMainIpcNekRemote.js";

export const desktopRemoteInteraction = new NekRemoteInteractionHostService();

/** Main projects one physical SSH status to its logical sessions; retry remains in the Host. */
export function createDesktopRemoteReconnect(options: {
  reattach(sessionId: string): Promise<void>;
  disconnect(sessionId: string): void;
  onError(sessionId: string, error: unknown): void;
}) {
  const bindings = new Map<
    string,
    {
      physicalId: string;
      child: { postMessage(message: unknown): void };
      detach(): void;
      kind: RemoteConnectionStatusEvent["kind"];
    }
  >();
  return {
    bind(sessionId: string, target: RemoteTarget, child: { postMessage(message: unknown): void }) {
      if (target.kind !== "ssh") return () => undefined;
      const physicalId = buildSshRemoteHostKey(target);
      const detach = desktopRemoteInteraction.attachReconnectAdapter(sessionId, {
        retryNow: () =>
          child.postMessage({
            type: "remote-reconnect-command",
            connectionId: physicalId,
            action: "retry",
          }),
        cancelReconnect: () =>
          child.postMessage({
            type: "remote-reconnect-command",
            connectionId: physicalId,
            action: "cancel",
          }),
        dispose: () => undefined,
      });
      bindings.set(sessionId, { physicalId, child, detach, kind: "connected" });
      return () => {
        if (bindings.get(sessionId)?.detach !== detach) return;
        bindings.delete(sessionId);
        detach();
      };
    },
    receive(child: { postMessage(message: unknown): void }, raw: unknown): boolean {
      const parsed = remoteDesktopMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type !== "remote-connection-status") return false;
      const event = parsed.data.event;
      for (const [sessionId, binding] of bindings) {
        if (binding.child !== child || binding.physicalId !== event.connectionId) continue;
        const previous = binding.kind;
        binding.kind = event.kind;
        desktopRemoteInteraction.emitStatus({ ...event, connectionId: sessionId });
        if (event.kind === "disconnected") options.disconnect(sessionId);
        if (event.kind === "connected" && previous !== "connected") {
          void options.reattach(sessionId).catch((error) => {
            desktopRemoteInteraction.emitStatus({
              connectionId: sessionId,
              kind: "failed",
              message: error instanceof Error ? error.message : String(error),
            });
            options.onError(sessionId, error);
          });
        }
      }
      return true;
    },
  };
}
