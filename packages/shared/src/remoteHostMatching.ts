import type { RemoteTargetSnapshot } from "./protocol.js";
import type { RemoteTarget } from "./remoteTarget.js";
import { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
import { buildSshConnectionKey } from "./remoteSshHostKey.js";

type HostTarget = RemoteTarget | RemoteTargetSnapshot;
interface SavedHost {
  connectionId: string;
  target: RemoteTarget;
  authMethod?: "agent" | "privateKey" | "password";
}

/** Explicit profile references are authoritative; legacy routes must have exactly one safe match.
 * SSH aliases can encode ProxyJump/IdentityFile, so an alias is never equated with its address.
 * Missing credentials are not evidence of a different machine, but explicit auth routes must agree.
 */
export function matchSavedRemoteHost<T extends SavedHost>(
  target: HostTarget | undefined,
  hosts: readonly T[],
): T | undefined {
  if (!target) return undefined;
  if (target.kind === "ssh" && target.savedHostId) {
    return hosts.find((host) => host.connectionId === target.savedHostId);
  }
  const candidates = hosts.filter((host) => {
    if (target.kind !== "ssh" || host.target.kind !== "ssh") {
      return target.kind === host.target.kind &&
        buildRemoteEnvironmentKey(target) === buildRemoteEnvironmentKey(host.target);
    }
    // Compare credentials when present, but never infer a password from a stripped live target.
    const password = ("password" in target && typeof target.password === "string") ||
      ("passwordCredentialKey" in target && Boolean(target.passwordCredentialKey));
    const auth = target.privateKeyPath ? "privateKey" : password ? "password" : undefined;
    if (auth && host.authMethod && auth !== host.authMethod) return false;
    const route = (value: typeof target) => {
      const { password: _password, ...rest } = value as RemoteTarget & { kind: "ssh" };
      return buildSshConnectionKey({ ...rest, passwordCredentialKey: undefined });
    };
    return route(target) === route(host.target);
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Attach only identity metadata; keep the caller's route and ephemeral credentials unchanged. */
export function withSavedRemoteHostId<T extends HostTarget>(target: T, hosts: readonly SavedHost[]): T {
  const host = matchSavedRemoteHost(target, hosts);
  return target.kind === "ssh" && host && !target.savedHostId
    ? { ...target, savedHostId: host.connectionId }
    : target;
}
