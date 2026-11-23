/** Project settings admission mirrors nek v0.5.1 modes/rpc/gui/config.ts:isProjectTrusted. */
import { resolveNekProjectTrust, type NekConfigScope } from "@zcode/shared/nek-protocol";
import { readNekProjectTrust } from "../nek-agent/projectTrust.js";
import { validationError } from "./errors.js";
import type { NekConfigRuntime, NekTargetContext } from "./runtime.js";

export async function settingsProjectTrusted(
  runtime: NekConfigRuntime,
  context: NekTargetContext,
  cwd: string,
): Promise<boolean> {
  const control = await runtime.control(context.target);
  const facts = await readNekProjectTrust(control, cwd);
  if (runtime.target(context.target).executor !== context.executor) {
    throw new Error("nek configuration target changed while checking project trust; retry");
  }
  return resolveNekProjectTrust(facts).trusted;
}

/** Like assertProjectTrustedForWrite, never write project settings while untrusted. */
export async function assertSettingsProjectTrusted(
  runtime: NekConfigRuntime,
  context: NekTargetContext,
  scope: NekConfigScope,
  cwd: string | undefined,
): Promise<void> {
  if (scope !== "project" || !cwd) return;
  if (await settingsProjectTrusted(runtime, context, cwd)) return;
  throw validationError(
    "Trust this project in Project settings before writing project settings.json",
    {
      cwd: "project is not trusted",
    },
  );
}
