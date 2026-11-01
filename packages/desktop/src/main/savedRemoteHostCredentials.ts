import { buildSshRemoteHostKey, type RemoteTarget } from "@zcode/shared";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import type { RemoteCredentialSafeStorage } from "./remoteCredentialSafeStorage.js";

export function savedHostAuthMethod(target: RemoteTarget): NekRemoteHost["authMethod"] {
  if (target.kind !== "ssh") return "agent";
  if (target.privateKeyPath) return "privateKey";
  return target.password === undefined ? "agent" : "password";
}

/** Saved-host form has no remember checkbox: Save stores its supplied secret; blank edit keeps it. */
export class SavedRemoteHostCredentials {
  constructor(private readonly store: Pick<RemoteCredentialSafeStorage,
    "getCredential" | "setCredential" | "deleteCredential">) {}

  private key(connectionId: string): string { return `remote-host:${connectionId}`; }

  async save(connectionId: string, target: RemoteTarget, previous?: RemoteTarget): Promise<void> {
    if (target.kind !== "ssh") return this.delete(connectionId);
    const sameIdentity = previous?.kind === "ssh" &&
      buildSshRemoteHostKey(target) === buildSshRemoteHostKey(previous);
    const old = sameIdentity ? await this.store.getCredential(this.key(connectionId)) : undefined;
    const credentials = {
      ...(target.privateKeyPath
        ? { ...(typeof old === "object" && old.privateKeyPassphrase ? { privateKeyPassphrase: old.privateKeyPassphrase } : {}) }
        : { ...(typeof old === "object" && old.password ? { password: old.password } : {}) }),
      ...(target.password !== undefined ? { password: target.password } : {}),
      ...(target.privateKeyPassphrase !== undefined ? { privateKeyPassphrase: target.privateKeyPassphrase } : {}),
    };
    if (Object.keys(credentials).length === 0) return this.delete(connectionId);
    const result = await this.store.setCredential(this.key(connectionId), credentials);
    if (!result.persisted) throw new Error("OS credential encryption is unavailable; remote host was not saved");
  }

  async restore(connectionId: string, target: RemoteTarget): Promise<RemoteTarget> {
    if (target.kind !== "ssh") return target;
    const stored = await this.store.getCredential(this.key(connectionId));
    if (stored === undefined) return target;
    if (typeof stored !== "object") throw new Error(`invalid saved-host credentials: ${connectionId}`);
    return {
      ...target,
      ...(stored.password !== undefined ? { password: stored.password } : {}),
      ...(stored.privateKeyPassphrase !== undefined ? { privateKeyPassphrase: stored.privateKeyPassphrase } : {}),
    };
  }

  async delete(connectionId: string): Promise<void> {
    await this.store.deleteCredential(this.key(connectionId));
  }
}
