import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import type { IRemoteBackend, RemoteNekCheckResult } from "@zcode/server/remote";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/nek-app" },
  clipboard: { writeText: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));
import { NekRemoteConfigConnectionRegistry } from "./desktopMainIpcNekConfig.js";
import { NekSettingsHostService } from "./desktopMainIpcNekHost.js";
import {
  createRemoteCredentialSafeStorage,
  type SafeStorageLike,
} from "./remoteCredentialSafeStorage.js";

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`cipher:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").slice("cipher:".length),
  };
}

function readyNek(): RemoteNekCheckResult {
  return {
    status: "ready",
    stderrSummary: "",
    info: {
      protocolVersion: 1,
      nekVersion: "0.4.0",
      piVersion: "1.0.0",
      node: { path: "/usr/bin/node", version: "24" },
      launch: { args: ["/opt/nek/cli.js"] },
      agentDir: "/home/alice/.nek/agent",
      sessionDir: "/home/alice/.nek/sessions",
      platform: "linux",
      arch: "x64",
    },
  };
}

test("saved SSH credentials use safeStorage and are restored only at connection time", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nek-host-settings-"));
  const hostsPath = join(directory, "hosts.json");
  const credentialStore = createRemoteCredentialSafeStorage({
    directory,
    safeStorage: fakeSafeStorage(),
  });
  let connectedTarget: NekRemoteHost["target"] | undefined;
  const backend: IRemoteBackend = {
    dispose: () => undefined,
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exec: async () => {
      throw new Error("exec is not expected in this test");
    },
    exists: async () => false,
    readFile: async () => "",
  };
  const remoteConfigs = new NekRemoteConfigConnectionRegistry({
    createBackend: async (target) => {
      connectedTarget = target;
      return backend;
    },
    detectNek: async () => readyNek(),
    detectConfigRuntime: async () => ({
      home: "/home/alice",
      agentDir: "/home/alice/.nek/agent",
      node: "/usr/bin/node",
    }),
  });
  const service = new NekSettingsHostService({
    credentialStore,
    remoteConfigs,
    hostsPath,
  });

  try {
    await service.saveHost({
      alias: "dev-box",
      target: {
        kind: "ssh",
        host: "remote.test",
        username: "alice",
        password: "never-on-disk",
      },
    });
    const hostsRaw = await fs.readFile(hostsPath, "utf8");
    const credentialRaw = await fs.readFile(credentialStore.filePath, "utf8");
    assert.doesNotMatch(hostsRaw, /never-on-disk/u);
    assert.doesNotMatch(credentialRaw, /never-on-disk/u);

    const hosts = await service.listHosts();
    assert.equal(hosts[0]?.authMethod, "password");
    await service.connectHost(hosts[0]!.connectionId);
    assert.deepEqual(connectedTarget, {
      kind: "ssh",
      host: "remote.test",
      username: "alice",
      password: "never-on-disk",
    });
  } finally {
    service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
