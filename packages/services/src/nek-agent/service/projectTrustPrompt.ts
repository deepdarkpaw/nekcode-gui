/**
 * nek v0.5.1: core/project-trust.ts and core/trust-manager.ts:getProjectTrustOptions.
 * RPC has no startup UI; the GUI drives the same select and persists through nek's trust store.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  resolveNekProjectTrust,
  type NekInteractionScope,
  type NekProjectTrustChoice,
} from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import { readNekProjectTrust } from "../projectTrust.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type { NekTrustPrompt } from "./types.js";

/** Render through exactly the same select channel as nek's extension UI. */
export function createProjectTrustPrompt(
  handlerFor: (scope: NekInteractionScope) => NekExtensionUiHandler | undefined,
): NekTrustPrompt {
  return async ({ workspacePath, cwd, resourcePaths, parentPath, options }) => {
    const handler = handlerFor({ workspacePath });
    if (!handler?.dialog) {
      throw new Error(
        `project trust decision required for ${cwd}, but no GUI interaction channel is attached`,
      );
    }
    const answer = await handler.dialog(
      {
        type: "extension_ui_request",
        id: `project-trust-${randomUUID()}`,
        method: "select",
        title: "Trust project folder?",
        options,
        projectTrust: { cwd, resourcePaths, parentPath },
      },
      new AbortController().signal,
    );
    return answer && "value" in answer
      ? options.find((option) => option === answer.value)
      : undefined;
  };
}

/** Startup precedence and persistence are independent of the renderer or the process launch. */
export async function requestProjectApproval(input: {
  cwd: string;
  askProjectTrust: NekTrustPrompt;
  ensureControl: () => Promise<{ client: NekRpcClient }>;
  assertCanAsk: () => void;
  assertAlive: () => void;
}): Promise<boolean> {
  const { cwd, askProjectTrust, assertCanAsk, assertAlive } = input;
  const { client } = await input.ensureControl();
  const trust = await readNekProjectTrust(client, cwd);
  const resolved = resolveNekProjectTrust(trust);
  if (resolved.kind !== "ask") return resolved.trusted;
  assertAlive();
  assertCanAsk();

  const resourcePaths = resolved.resources.map(({ path }) => path);
  // Unlike RPC's `cwd`, the resource path is rooted at nek's realpath(cwd)/.nek.
  // The ask case guarantees a gated resource, so parent trust also works through symlinks.
  const canonicalCwd = dirname(dirname(resourcePaths[0]!));
  const parent = dirname(canonicalCwd);
  const parentPath = parent === canonicalCwd ? undefined : parent;
  const options: NekProjectTrustChoice[] = ["trust"];
  if (parentPath !== undefined) options.push("trust-parent");
  options.push("trust-session", "deny", "deny-session");
  const choice = await askProjectTrust({
    workspacePath: cwd,
    cwd: trust.cwd,
    resourcePaths,
    parentPath,
    options,
  });
  assertAlive();

  switch (choice) {
    case "trust-parent": {
      if (parentPath === undefined) throw new Error(`project ${cwd} has no parent folder`);
      // Core sets parent=true and clears the child's record. RPC cannot clear, so assert that
      // no record (including one added while this card was open) could mask the new decision.
      const current = await client.call({ type: "get_project_trust", cwd });
      assertAlive();
      if (current.trusted !== null) {
        throw new Error(
          `project trust changed for ${cwd}; reopen the session to use the saved decision`,
        );
      }
      await client.call({ type: "set_project_trust", cwd: parentPath, trusted: true });
      return true;
    }
    case "trust":
    case "deny": {
      const trusted = choice === "trust";
      await client.call({ type: "set_project_trust", cwd, trusted });
      return trusted;
    }
    default:
      return choice === "trust-session";
  }
}
