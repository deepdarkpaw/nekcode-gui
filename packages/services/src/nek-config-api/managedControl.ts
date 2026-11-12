/**
 * Managed control client: spawn once, prove its models.json content, then admit model reads.
 *
 * A freshly spawned control process already loaded models.json; comparing the content before
 * spawn with the content after its first ACK lets us skip the otherwise mandatory proving
 * reload (measured ~1 s on a cold start). Any change inside that window disables the seed.
 */
import type {
  NekConfigTarget,
  NekModelRuntimeHandle,
  NekReloadResult,
} from "@zcode/shared/nek-protocol";
import type { NekControlClient } from "./control.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import type { NekConfigApiLogger, NekReloadOutcome, NekTargetContext } from "./runtime.js";
import { modelRuntimeFingerprint, type NekLiveModelRuntime } from "./modelRuntime.js";
import { NekControlModelReads, withModelReadAdmission } from "./controlModelReads.js";

/** Content at spawn vs after ACK; equal means no proving reload is required. */
export async function seededControlFingerprint(
  executor: NekConfigHostExecutor,
  atSpawn: Promise<string | undefined>,
): Promise<string | undefined> {
  const [before, after] = await Promise.all([
    atSpawn,
    modelRuntimeFingerprint(executor).catch(() => undefined),
  ]);
  return before !== undefined && before === after ? after : undefined;
}

export async function openManagedControl(input: {
  target: NekConfigTarget;
  context: NekTargetContext;
  factory: (args: {
    target: NekConfigTarget;
    executor: NekConfigHostExecutor;
    logger?: NekConfigApiLogger;
  }) => Promise<NekControlClient>;
  logger?: NekConfigApiLogger;
  register: (
    options: {
      handle: NekModelRuntimeHandle;
      fingerprint: () => Promise<string>;
      release: () => void;
      diagnostics?: (result: NekReloadResult) => void;
    },
    registration?: { initialFingerprint?: string },
  ) => NekLiveModelRuntime;
  setLease: (lease: NekLiveModelRuntime | undefined) => void;
  report: (result: NekReloadOutcome) => void;
  isCurrent: () => boolean;
}): Promise<NekControlClient> {
  const { context, target, logger } = input;
  const atSpawn = modelRuntimeFingerprint(context.executor).catch(() => undefined);
  const client = await input.factory({
    target,
    executor: context.executor,
    logger,
  });
  if (!input.isCurrent()) {
    void client
      .close()
      .catch((error: unknown) => logger?.warn("retired nek control close failed", error));
    throw new Error("nek control retired during creation; retry");
  }
  const reads = new NekControlModelReads(context.executor);
  const initialFingerprint = await seededControlFingerprint(context.executor, atSpawn);
  let lease: NekLiveModelRuntime;
  try {
    lease = input.register(
      {
        handle: {
          sessionKey: "control",
          cwd: "",
          isWritable: () => input.isCurrent(),
          reload: () => client.call({ type: "reload" }),
          rebindModel: async () => undefined,
          call: ((command) => client.call(command)) as NekModelRuntimeHandle["call"],
        },
        fingerprint: () => modelRuntimeFingerprint(context.executor),
        diagnostics: (result: NekReloadResult) => input.report(reloadOutcome(result)),
        release: () => {
          reads.dispose();
          input.setLease(undefined);
        },
      },
      initialFingerprint === undefined ? {} : { initialFingerprint },
    );
  } catch (error) {
    void client
      .close()
      .catch((closeError: unknown) =>
        logger?.warn("unregistered nek control close failed", closeError),
      );
    throw error;
  }
  input.setLease(lease);
  return withModelReadAdmission(client, lease, reads);
}

function reloadOutcome(result: NekReloadResult): NekReloadOutcome {
  return {
    reloaded: result.deferred ? 0 : 1,
    deferred: result.deferred ? 1 : 0,
    diagnostics: result.diagnostics,
    failures: [],
  };
}
