/**
 * nek v0.5.1: core/{project-trust,trust-manager}.ts and modes/rpc/gui/{config,trust}.ts.
 * The RPC supplies the stored (possibly inherited) decision and existing resources. Only the
 * precedence and the core allowlist are mirrored: RPC also lists `agents`, which never cause a prompt.
 */
import type { NekProjectTrust, NekProjectTrustResource } from "./gui-rpc.js";

const CORE_KINDS: ReadonlySet<NekProjectTrustResource["kind"]> = new Set([
  "settings",
  "mcp",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "system_prompt",
]);

/** Stable values carried by the existing select channel; the renderer localizes their labels. */
export type NekProjectTrustChoice =
  | "trust"
  | "trust-parent"
  | "trust-session"
  | "deny"
  | "deny-session";

/** The default before any session-only override. `ask` is untrusted for non-interactive config RPCs. */
export function resolveNekProjectTrust(trust: NekProjectTrust) {
  const resources = trust.resources.filter(({ kind }) => CORE_KINDS.has(kind));
  if (trust.trusted !== null) return { kind: "record", trusted: trust.trusted, resources } as const;
  if (resources.length === 0) return { kind: "noResources", trusted: true, resources } as const;
  if (trust.defaultProjectTrust !== "ask") {
    return { kind: "policy", trusted: trust.defaultProjectTrust === "always", resources } as const;
  }
  return { kind: "ask", trusted: false, resources } as const;
}
