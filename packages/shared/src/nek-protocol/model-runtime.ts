import type { NekReloadResult } from "./gui-rpc.js";
import type { NekRpcCommandOfType, NekRpcCommandType, NekRpcResponseDataFor } from "./rpc.js";

/** A live CLI writer, never a recipe for starting/reopening a session. */
export interface NekModelRuntimeHandle {
  readonly sessionKey: string;
  readonly cwd: string;
  isWritable(): boolean;
  reload(): Promise<NekReloadResult>;
  rebindModel(): Promise<void>;
  call<C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ): Promise<NekRpcResponseDataFor<C>>;
}

/** Process-identity scoped admission; release it before detaching/replacing the process. */
export interface NekModelRuntimeLease {
  run<T>(kind: "selection" | "input", command: () => Promise<T>): Promise<T>;
  reload(): Promise<NekReloadResult>;
  dispose(): void;
}

/** Machine-local config owner. Session owners register only their existing live writers. */
export interface NekModelRuntimeFreshness {
  /**
   * `initialFingerprint`：该进程启动前、后 models.json 内容一致时由装配方传入。
   * 进程按磁盘配置加载完成，因此首次使用不需要再做一次证明性 reload。
   */
  register(
    handle: NekModelRuntimeHandle,
    options?: { initialFingerprint?: string },
  ): NekModelRuntimeLease;
}
