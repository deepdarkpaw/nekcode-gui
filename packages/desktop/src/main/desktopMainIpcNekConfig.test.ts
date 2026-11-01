import assert from "node:assert/strict";
import { test } from "vitest";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import type {
  IRemoteBackend,
  LocalPortForwardHandle,
  RemoteNekCheckResult,
} from "@zcode/server/remote";
import { NekRemoteConfigConnectionRegistry } from "./desktopMainIpcNekConfig.js";

const target: NekRemoteHost["target"] = {
  kind: "ssh",
  host: "remote.test",
  username: "alice",
};

function createBackend(): {
  backend: IRemoteBackend;
  closes: number[];
  ports: number[];
} {
  const closes: number[] = [];
  const ports: number[] = [];
  const backend = {
    dispose: () => undefined,
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exec: async () => {
      throw new Error("exec is not expected in this test");
    },
    exists: async () => false,
    readFile: async () => "",
    forwardLocalPortToRemote: async (localPort: number, remotePort: number) => {
      ports.push(localPort, remotePort);
      const handle: LocalPortForwardHandle = {
        localPort,
        remotePort,
        close: async () => {
          closes.push(localPort);
        },
      };
      return handle;
    },
  } satisfies IRemoteBackend;
  return { backend, closes, ports };
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

test("remote config registry forwards OAuth ports and closes every lease", async () => {
  const first = createBackend();
  const registry = new NekRemoteConfigConnectionRegistry({
    createBackend: async () => first.backend,
    detectNek: async () => readyNek(),
    detectConfigRuntime: async () => ({
      home: "/home/alice",
      agentDir: "/home/alice/.nek/agent",
      node: "/usr/bin/node",
    }),
  });

  await registry.connect("ssh-1", target);
  const lease = await registry.forwardLoginPorts(
    { kind: "remote", connectionId: "ssh-1" },
    [53692, 1455],
  );
  assert.deepEqual(lease.ports, [53692, 1455]);
  assert.deepEqual(first.ports, [53692, 53692, 1455, 1455]);
  await lease.close();
  await lease.close();
  assert.deepEqual(first.closes, [53692, 1455]);
  await registry.dispose();
});
