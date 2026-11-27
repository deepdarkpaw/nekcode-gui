import type { RemoteTargetSnapshot } from "./protocol.js";
import type { RemoteTarget } from "./remoteTarget.js";
import { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
import { buildSshConnectionKey } from "./remoteSshHostKey.js";

type HostTarget = RemoteTarget | RemoteTargetSnapshot;
type SshTarget = Extract<HostTarget, { kind: "ssh" }>;
interface SavedHost {
  connectionId: string;
  target: RemoteTarget;
  authMethod?: "agent" | "privateKey" | "password";
}

/** SSH aliases are separate routing authorities, even when their visible addresses agree. */
export function sameSshHostDestination(a: SshTarget, b: SshTarget): boolean {
  return (
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.username.trim() === b.username.trim() &&
    (a.port ?? 22) === (b.port ?? 22) &&
    a.sshConfigAlias === b.sshConfigAlias
  );
}

export function sameRemoteHostDestination(a: HostTarget, b: HostTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "ssh" && b.kind === "ssh"
    ? sameSshHostDestination(a, b)
    : buildRemoteEnvironmentKey(a) === buildRemoteEnvironmentKey(b);
}

function sshAuthMethod(target: SshTarget): SavedHost["authMethod"] {
  if (target.privateKeyPath) return "privateKey";
  if (
    ("password" in target && typeof target.password === "string") ||
    ("passwordCredentialKey" in target && target.passwordCredentialKey)
  )
    return "password";
  return undefined;
}

function sameLegacySshRoute(target: SshTarget, host: SavedHost): boolean {
  if (host.target.kind !== "ssh" || !sameSshHostDestination(target, host.target)) return false;
  const auth = sshAuthMethod(target);
  if (auth && host.authMethod && auth !== host.authMethod) return false;
  // A redacted live target may not carry a password, so compare routes without secrets.
  const { password: _password, ...route } = target as Extract<RemoteTarget, { kind: "ssh" }>;
  const { password: _savedPassword, ...savedRoute } = host.target;
  return (
    buildSshConnectionKey({ ...route, passwordCredentialKey: undefined }) ===
    buildSshConnectionKey(savedRoute)
  );
}

/** An explicit profile never falls through to another profile; a legacy route must match uniquely. */
export function matchSavedRemoteHost<T extends SavedHost>(
  target: HostTarget | undefined,
  hosts: readonly T[],
): T | undefined {
  if (!target) return undefined;
  if (target.kind === "ssh" && target.savedHostId) {
    return hosts.find(
      (host) =>
        host.connectionId === target.savedHostId &&
        host.target.kind === "ssh" &&
        sameSshHostDestination(target, host.target),
    );
  }
  const candidates = hosts.filter((host) =>
    target.kind === "ssh"
      ? sameLegacySshRoute(target, host)
      : target.kind === host.target.kind &&
        buildRemoteEnvironmentKey(target) === buildRemoteEnvironmentKey(host.target),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Attach only identity metadata; keep the caller's route and ephemeral credentials unchanged. */
export function withSavedRemoteHostId<T extends HostTarget>(
  target: T,
  hosts: readonly SavedHost[],
): T {
  const host = matchSavedRemoteHost(target, hosts);
  return target.kind === "ssh" &&
    host &&
    !target.savedHostId &&
    (host.authMethod !== "password" || sshAuthMethod(target) === "password")
    ? { ...target, savedHostId: host.connectionId }
    : target;
}

/** Persist main's verified profile association without copying transport secrets or changing the route. */
export function inheritConnectedSavedHostId(
  target: RemoteTarget,
  connected?: RemoteTarget,
): RemoteTarget {
  return target.kind === "ssh" &&
    !target.savedHostId &&
    connected?.kind === "ssh" &&
    connected.savedHostId &&
    sameSshHostDestination(target, connected)
    ? { ...target, savedHostId: connected.savedHostId }
    : target;
}
