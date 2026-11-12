import type { NekModelRuntimeFreshness } from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekSessionRecord } from "./types.js";

/** Retire the model admission lease before releasing event subscriptions/process identity. */
export function detachNekSessionProcess(record: NekSessionRecord): void {
  record.modelRuntime?.dispose();
  record.modelRuntime = undefined;
  record.detachEvents?.();
  record.detachEvents = undefined;
  record.detachExit?.();
  record.detachExit = undefined;
  record.process = undefined;
}

/** The lease closes over the exact process; reload never acquires/reopens a session. */
export function bindNekSessionModelRuntime(
  record: NekSessionRecord,
  process: NekRpcProcess,
  freshness?: NekModelRuntimeFreshness,
): void {
  if (
    !freshness ||
    record.modelRuntime ||
    record.process !== process ||
    record.closing ||
    record.readonly
  )
    return;
  const isWritable = () => !record.closing && !record.readonly && record.process === process;
  const assertLive = () => {
    if (!isWritable()) throw new Error("nek process changed or closed; retry");
  };
  record.modelRuntime = freshness.register({
    sessionKey: record.key,
    cwd: record.cwd,
    isWritable,
    call: (command) => {
      assertLive();
      return process.client.call(command);
    },
    reload: async () => {
      assertLive();
      const result = await process.client.call({ type: "reload" });
      assertLive();
      return result;
    },
    rebindModel: async () => {
      assertLive();
      const state = await process.client.call({ type: "get_state" });
      assertLive();
      if (state.model)
        await process.client.call({
          type: "set_model",
          provider: state.model.provider,
          modelId: state.model.id,
        });
    },
  });
}
