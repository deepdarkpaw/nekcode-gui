import type {
  IRemoteInteractionHostApi,
  RemoteConnectionStatusEvent,
  RemotePromptEvent,
  RemotePromptListener,
  RemotePromptResponse,
  RemoteConnectionStatusListener,
} from "@zcode/shared/nek-protocol";
import type { RemotePromptBroker, RemoteReconnectStatusAdapter } from "@zcode/server/remote";

type Listener<T> = (event: T) => void;

/** Owns renderer-facing remote prompts; SSH adapters attach their broker to this owner. */
export class NekRemoteInteractionHostService implements IRemoteInteractionHostApi {
  private readonly promptListeners = new Set<RemotePromptListener>();
  private readonly statusListeners = new Set<RemoteConnectionStatusListener>();
  private readonly brokers = new Map<string, RemotePromptBroker>();
  private readonly reconnectAdapters = new Map<string, RemoteReconnectStatusAdapter>();

  onRemotePrompt(listener: RemotePromptListener): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  async respondRemotePrompt(id: string, response: RemotePromptResponse): Promise<void> {
    for (const broker of this.brokers.values()) {
      if (broker.respondRemotePrompt(id, response)) return;
    }
    throw new Error(`remote prompt is no longer pending: ${id}`);
  }

  onRemoteConnectionStatus(listener: RemoteConnectionStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async retryNow(connectionId: string): Promise<void> {
    const adapter = this.reconnectAdapters.get(connectionId);
    if (!adapter) throw new Error(`remote reconnect state is unavailable: ${connectionId}`);
    adapter.retryNow();
  }

  async cancelReconnect(connectionId: string): Promise<void> {
    const adapter = this.reconnectAdapters.get(connectionId);
    if (!adapter) throw new Error(`remote reconnect state is unavailable: ${connectionId}`);
    adapter.cancelReconnect();
  }

  attachBroker(connectionId: string, broker: RemotePromptBroker): () => void {
    this.brokers.set(connectionId, broker);
    broker.rendererDidConnect();
    return () => {
      if (this.brokers.get(connectionId) !== broker) return;
      this.brokers.delete(connectionId);
      broker.rendererDidDisconnect();
    };
  }

  attachReconnectAdapter(connectionId: string, adapter: RemoteReconnectStatusAdapter): () => void {
    this.reconnectAdapters.set(connectionId, adapter);
    return () => {
      if (this.reconnectAdapters.get(connectionId) !== adapter) return;
      this.reconnectAdapters.delete(connectionId);
      adapter.dispose();
    };
  }

  emitPrompt(event: RemotePromptEvent): void {
    this.emit(this.promptListeners, event);
  }

  emitStatus(event: RemoteConnectionStatusEvent): void {
    this.emit(this.statusListeners, event);
  }

  dispose(): void {
    for (const broker of this.brokers.values()) broker.rendererDidDisconnect();
    for (const adapter of this.reconnectAdapters.values()) adapter.dispose();
    this.brokers.clear();
    this.reconnectAdapters.clear();
    this.promptListeners.clear();
    this.statusListeners.clear();
  }

  private emit<T>(listeners: Set<Listener<T>>, event: T): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot be allowed to break another subscriber.
      }
    }
  }
}
