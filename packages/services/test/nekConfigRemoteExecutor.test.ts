import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NekConfigApi } from "../src/nek-config-api/index.js";
import {
  createRemoteNekConfigHostExecutor,
  detectRemoteConfigRuntime,
  type NekRemoteConfigConnection,
  type NekRemoteConfigExecStream,
} from "../src/nek-config-api/remoteHostExecutor.js";

interface FakeRemote {
  connection: NekRemoteConfigConnection;
  commands: string[];
  /** 远端写下的文件（`write` 之后按路径可读）。 */
  files: Map<string, string>;
}

function base64PayloadOf(command: string): string[] {
  // 命令形如 `'<node>' -e '<script>' '<base64 payload>'`；payload 是最后一个单引号段。
  const payload = /'([A-Za-z0-9+/=]+)'$/u.exec(command)?.[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as string[];
}

function fakeConnection(options: { fail?: boolean; node?: string } = {}): FakeRemote {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const connection: NekRemoteConfigConnection = {
    async exec(command): Promise<NekRemoteConfigExecStream> {
      commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners = new Set<(code: number) => void>();
      const isProbe = command.startsWith("sh -lc 'printf");
      const [operation = "", ...values] = isProbe ? [] : base64PayloadOf(command);
      let value: unknown = null;
      if (operation === "read") {
        value = { content: files.get(values[0] ?? "") ?? null };
      } else if (operation === "write") {
        files.set(values[0] ?? "", Buffer.from(values[1] ?? "", "base64").toString("utf8"));
      } else if (operation === "stat") {
        value = { mtimeMs: 7, size: 2, isDirectory: false };
      } else if (operation === "listDir") {
        value = [{ name: "settings.json", isDirectory: false }];
      }
      const probe = ["/home/remote", "/home/remote/.nek/agent", options.node ?? "/usr/bin/node"];
      setImmediate(() => {
        if (options.fail) {
          stderr.end("remote failure");
          for (const listener of listeners) listener(1);
          return;
        }
        stdout.end(isProbe ? `${probe.join("\n")}\n` : JSON.stringify({ ok: true, value }));
        for (const listener of listeners) listener(0);
      });
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        onClose(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
    },
  };
  return { connection, commands, files };
}

test("remote executor runs config primitives on a connected target", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection);
  assert.deepEqual(runtime, {
    home: "/home/remote",
    agentDir: "/home/remote/.nek/agent",
    node: "/usr/bin/node",
  });
  const executor = createRemoteNekConfigHostExecutor({
    id: "remote:box",
    runtime,
    connection: fake.connection,
  });
  await executor.writeFileAtomic("/home/remote/.nek/agent/settings.json", '{"a":1}');
  assert.equal(await executor.readFile("/home/remote/.nek/agent/settings.json"), '{"a":1}');
  assert.equal(await executor.readFile("/home/remote/.nek/agent/missing.json"), null);
  assert.deepEqual(await executor.stat("/tmp/settings.json"), {
    mtimeMs: 7,
    size: 2,
    isDirectory: false,
  });
  assert.deepEqual(await executor.listDir("/tmp"), [{ name: "settings.json", isDirectory: false }]);
  await executor.rename("/tmp/settings.json", "/tmp/settings.next.json");
  await executor.remove("/tmp/settings.next.json");
  assert.equal(executor.agentDir(), "/home/remote/.nek/agent");
  assert.equal(executor.homeDir(), "/home/remote");
});

test("remote executor holds the remote lock around the settings read-modify-write", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection);
  const executor = createRemoteNekConfigHostExecutor({
    id: "remote:box",
    runtime,
    connection: fake.connection,
  });
  await executor.writeFileAtomic("/home/remote/.nek/agent/settings.json", '{"a":1}');
  await executor.lock?.runLocked("/home/remote/.nek/agent/settings.json", (current) => {
    const parsed = JSON.parse(current ?? "{}") as Record<string, unknown>;
    return `${JSON.stringify({ ...parsed, b: 2 })}\n`;
  });
  assert.equal(await executor.readFile("/home/remote/.nek/agent/settings.json"), '{"a":1,"b":2}\n');
  const operations = fake.commands
    .filter((command) => command.startsWith("'/usr/bin/node'"))
    .map((command) => base64PayloadOf(command)[0]);
  assert.deepEqual(operations.slice(0, 5), ["write", "lock", "read", "write", "unlock"]);
});

test("remote executor exposes remote command failures", async () => {
  const fake = fakeConnection({ fail: true });
  await assert.rejects(() => detectRemoteConfigRuntime(fake.connection), /remote failure/u);
});

test("remote runtime detection fails loudly when the remote has no node", async () => {
  const fake = fakeConnection({ node: "" });
  await assert.rejects(() => detectRemoteConfigRuntime(fake.connection), /缺少 Node 运行时/u);
});

test("remote executor backs settings reads and locked writes for a connected target", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection);
  const executor = createRemoteNekConfigHostExecutor({
    id: "remote:box",
    runtime,
    connection: fake.connection,
  });
  const target = { kind: "remote" as const, connectionId: "box" };
  const api = new NekConfigApi({
    hosts: {
      executor: (requested) => (requested.kind === "remote" ? executor : undefined),
      listTargets: async () => [],
    },
    config: { autoReload: false, remoteConfigPollSeconds: 3600, watchDebounceMs: 5 },
  });
  try {
    const read = await api.readSettings(target, "global");
    await api.patchSettings(
      target,
      "global",
      { defaultModel: "acme/sonnet" },
      { revision: read.revision },
    );
    const after = await api.readSettings(target, "global");
    assert.equal(after.values.defaultModel, "acme/sonnet");
    assert.equal(
      [...fake.files.values()].some((content) => content.includes("acme/sonnet")),
      true,
      "the write must reach the remote settings.json",
    );
    const operations = fake.commands
      .filter((command) => command.startsWith("'/usr/bin/node'"))
      .map((command) => base64PayloadOf(command)[0]);
    assert.equal(operations.includes("lock"), true);
    assert.equal(operations.includes("unlock"), true);
  } finally {
    api.dispose();
  }
});
