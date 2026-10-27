import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { computeSshConfigHostFromFile } from "./sshConfig.js";
import { resolveSSHAuthentication } from "./sshAuth.js";
import type { HostKeyConfirmation } from "./sshKnownHosts.js";

export interface CreateRemoteBackendOptions {
  sshConfigPath?: string;
  requireHostKeyConfirmation?: boolean;
  confirmHostKey?: (confirmation: HostKeyConfirmation) => Promise<boolean> | boolean;
  askPassphrase?: (privateKeyPath?: string) => Promise<string | undefined> | string | undefined;
  askPassword?: () => Promise<string | undefined> | string | undefined;
}

export async function createRemoteBackend(
  target: RemoteTarget,
  options: CreateRemoteBackendOptions = {},
): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      const { SSHBackend } = await import("./ssh-backend.js");
      const config = await computeSshConfigHostFromFile(target.sshConfigAlias ?? target.host, {
        filePath: options.sshConfigPath,
        username: target.username || undefined,
        port: target.port,
      });
      const privateKeyPath = target.privateKeyPath ?? config.identityFiles[0];
      let privateKey: string | Buffer | undefined;
      if (privateKeyPath) {
        const keyPath = privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }
      const authentication = await resolveSSHAuthentication({
        privateKey,
        privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        password: target.password,
        askPassphrase: options.askPassphrase,
      });

      return new SSHBackend({
        host: config.hostName,
        port: config.port,
        username: config.username ?? target.username,
        password: authentication.password,
        agent: config.identitiesOnly ? undefined : authentication.agent,
        privateKeyPath,
        privateKeyPassphrase: authentication.privateKeyPassphrase,
        privateKey,
        askPassword: options.askPassword,
        requireHostKeyConfirmation: options.requireHostKeyConfirmation ?? true,
        confirmHostKey: options.confirmHostKey,
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
  }
}
