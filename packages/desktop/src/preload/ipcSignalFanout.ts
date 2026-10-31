/**
 * 单个 IPC 信道的 renderer 侧扇出。
 *
 * 根因背景：`zcode:settings-changed` 之前是「一个 renderer 订阅 = 一个 `ipcRenderer.on`」。
 * `useSettings()` 之类的 hook 每个挂载实例都订阅一次，同时有 10 个以上消费者时
 * Node 的 EventEmitter 就会打印 `MaxListenersExceededWarning`。扇出后不论多少消费者，
 * 原生信道上永远只有 1 个监听；`setMaxListeners` 只是把告警关掉，问题本身还在，所以不用。
 */

/**
 * 每个信道同时存在的订阅者上限。消费者都是组件级订阅，正常量级是几十个
 * （打包应用实际观测 11 个）；超过上限说明某个 effect 没有在卸载时退订，属于必须暴露的
 * bug，因此直接抛错而不是静默丢弃订阅。
 */
export const MAX_IPC_SIGNAL_SUBSCRIBERS = 64;

export interface IpcSignalSource {
  on(channel: string, listener: () => void): void;
  removeListener(channel: string, listener: () => void): void;
}

export interface IpcSignalFanout {
  subscribe(callback: () => void): () => void;
  subscriberCount: () => number;
}

/** Keep one native IPC listener while allowing many renderer subscribers. */
export function createIpcSignalFanout(source: IpcSignalSource, channel: string): IpcSignalFanout {
  // 每次订阅登记独立闭包：同一个回调订阅两次时互不影响退订。
  const callbacks = new Set<() => void>();
  const listener = () => {
    for (const callback of Array.from(callbacks)) callback();
  };

  return {
    subscribe(callback: () => void): () => void {
      if (callbacks.size >= MAX_IPC_SIGNAL_SUBSCRIBERS) {
        throw new Error(
          `${channel} fanout exceeded ${MAX_IPC_SIGNAL_SUBSCRIBERS} subscribers; a renderer consumer is not releasing its subscription`,
        );
      }
      const entry = () => callback();
      callbacks.add(entry);
      if (callbacks.size === 1) source.on(channel, listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        callbacks.delete(entry);
        if (callbacks.size === 0) source.removeListener(channel, listener);
      };
    },
    subscriberCount: () => callbacks.size,
  };
}
