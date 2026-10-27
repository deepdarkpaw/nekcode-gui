/**
 * mock 的事件分发：配置监视（watch）与写盘后 reload 结果的订阅表。
 *
 * 拆出这个文件是因为 `mockNekConfigApi.ts` 已经接近 400 行上限；这里只有订阅与广播，
 * 具体"什么时候发事件"仍由 mock 的写入路径决定。
 */
import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import type { NekConfigChange } from "../NekSettingsContext.js";

type ChangeListener = (change: NekConfigChange) => void;
type ReloadListener = (result: NekSessionReloadOutcome) => void;

export class MockEventHub {
  private readonly watchers = new Map<string, Set<ChangeListener>>();
  private readonly reloads = new Map<string, Set<ReloadListener>>();

  /** 订阅某个目标的 watch 事件；返回退订函数。 */
  watch(targetKey: string, listener: ChangeListener): () => void {
    const set = this.watchers.get(targetKey) ?? new Set<ChangeListener>();
    set.add(listener);
    this.watchers.set(targetKey, set);
    return () => {
      set.delete(listener);
    };
  }

  publish(targetKey: string, change: NekConfigChange): void {
    for (const listener of this.watchers.get(targetKey) ?? []) {
      listener(change);
    }
  }

  /** 订阅某个目标的 reload 结果。 */
  onReload(targetKey: string, listener: ReloadListener): () => void {
    const set = this.reloads.get(targetKey) ?? new Set<ReloadListener>();
    set.add(listener);
    this.reloads.set(targetKey, set);
    return () => {
      set.delete(listener);
    };
  }

  emitReload(targetKey: string, result: NekSessionReloadOutcome): void {
    for (const listener of this.reloads.get(targetKey) ?? []) {
      listener(result);
    }
  }
}
