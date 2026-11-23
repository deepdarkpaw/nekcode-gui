/** Runtime project trust facts come from nek v0.5.1's control RPC (modes/rpc/gui/trust.ts). */
import { basename } from "node:path";
import {
  resolveNekProjectTrust,
  type NekProjectTrust,
  type NekRpcCommandOfType,
  type NekRpcResponseDataFor,
} from "@zcode/shared/nek-protocol";

interface TrustReadClient {
  call<C extends "get_project_trust" | "reload">(
    command: NekRpcCommandOfType<C>,
  ): Promise<NekRpcResponseDataFor<C>>;
}

/** The store/resources are read on every RPC; only the global policy lives in the cached process. */
export async function readNekProjectTrust(
  client: TrustReadClient,
  cwd: string,
): Promise<NekProjectTrust> {
  const read = () => client.call<"get_project_trust">({ type: "get_project_trust", cwd });
  const facts = await read();
  const decision = resolveNekProjectTrust(facts);
  if (decision.kind === "record" || decision.kind === "noResources") return facts;

  // Control and session pools need not share a process. A cached `always` must not override a
  // newly saved `never`. Reload only when the policy matters, without touching a live session.
  const { deferred, diagnostics } = await client.call<"reload">({ type: "reload" });
  if (deferred) throw new Error("nek control did not refresh the project trust policy; retry");
  const settingsError = diagnostics.find(
    ({ file, severity }) => severity === "error" && basename(file) === "settings.json",
  );
  if (settingsError) {
    // SettingsManager.reload keeps the old values on read errors; do not apply that stale policy.
    throw new Error(
      `Could not read the global project trust policy: ${settingsError.message}. Fix settings.json and retry.`,
    );
  }
  return await read();
}
