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
  register(handle: NekModelRuntimeHandle): NekModelRuntimeLease;
}
