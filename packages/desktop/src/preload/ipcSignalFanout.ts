export interface IpcSignalSource {
  on(channel: string, listener: () => void): void;
  removeListener(channel: string, listener: () => void): void;
}

/** Keep one native IPC listener while allowing many renderer subscribers. */
export function createIpcSignalFanout(source: IpcSignalSource, channel: string) {
  const callbacks = new Set<() => void>();
  const listener = () => {
    for (const callback of callbacks) callback();
  };

  return {
    subscribe(callback: () => void): () => void {
      callbacks.add(callback);
      if (callbacks.size === 1) source.on(channel, listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        callbacks.delete(callback);
        if (callbacks.size === 0) source.removeListener(channel, listener);
      };
    },
    subscriberCount: () => callbacks.size,
  };
}
