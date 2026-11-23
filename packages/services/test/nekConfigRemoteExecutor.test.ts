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

/** 远端 `nek gui-info` 给出的启动信息：Node 不在 PATH 上（例如系统 PATH 里只有旧版 node）。 */
const NEK_INFO = {
  node: { path: "/home/remote/.local/share/pi-node/bin/node", version: "v22.23.1" },
  launch: { args: ["--import", "file:///opt/nek/resolver.ts", "/opt/nek/cli.ts"] },
  platform: "linux",
};

/** 最小 POSIX 引号去除：只支持单引号段、双引号段与空白分词（够验证嵌套 `sh -c`）。 */
function posixWords(command: string): string[] {
  const words: string[] = [];
  let current: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      assert.ok(end > index, `unterminated ${char} in ${command}`);
      current = (current ?? "") + command.slice(index + 1, end);
      index = end;
    } else if (/\s/u.test(char)) {
      if (current !== undefined) words.push(current);
      current = undefined;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== undefined) words.push(current);
  return words;
}

function fakeConnection(options: { fail?: boolean } = {}): FakeRemote {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const connection: NekRemoteConfigConnection = {
    async exec(command): Promise<NekRemoteConfigExecStream> {
      commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners = new Set<(code: number) => void>();
      const stream: NekRemoteConfigExecStream = {
        stdin: new PassThrough(),
        stdout,
        stderr,
        onClose(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
      // 启动 nek 的长连接：保持打开，由测试检查命令本身。
      if (command.startsWith("sh -lc 'exec ")) return stream;
      const isProbe = command.startsWith("sh -lc 'printf");
      const [operation = "", ...values] = isProbe ? [] : base64PayloadOf(command);
      let value: unknown = null;
      if (operation === "read") {
        value = { content: files.get(values[0] ?? "") ?? null };
      } else if (operation === "write") {
        files.set(values[0] ?? "", Buffer.from(values[1] ?? "", "base64").toString("utf8"));
      } else if (operation === "stat") {
        const content = files.get(values[0] ?? "");
        value = {
          mtimeMs: 7,
          size: content === undefined ? 2 : Buffer.byteLength(content),
          isDirectory: false,
        };
      } else if (operation === "listDir") {
        value = [{ name: "settings.json", isDirectory: false }];
      }
      const probe = ["/home/remote", "/home/remote/.nek/agent"];
      setImmediate(() => {
        // ssh2 的退出码可能先于最后一段输出到达：先报退出码，再写输出。
        if (options.fail) {
          for (const listener of listeners) listener(1);
          setImmediate(() => {
            stdout.end();
            stderr.end("remote failure");
          });
          return;
        }
        for (const listener of listeners) listener(0);
        setImmediate(() => {
          stdout.end(isProbe ? `${probe.join("\n")}\n` : JSON.stringify({ ok: true, value }));
          stderr.end();
        });
      });
      return stream;
    },
  };
  return { connection, commands, files };
}

test("remote executor runs config primitives on a connected target", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection, NEK_INFO);
  assert.deepEqual(runtime, {
    home: "/home/remote",
    agentDir: "/home/remote/.nek/agent",
    node: NEK_INFO.node.path,
    launchArgs: NEK_INFO.launch.args,
    platform: "linux",
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
  assert.equal(executor.platform(), "linux");
  const scripts = fake.commands.filter((command) => !command.startsWith("sh -lc"));
  assert.ok(scripts.length > 0);
  for (const command of scripts) {
    assert.equal(
      posixWords(command)[0],
      NEK_INFO.node.path,
      "config scripts run on gui-info's node",
    );
  }
});

test("remote executor starts nek with gui-info's node and launch args through one nested sh", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection, NEK_INFO);
  const executor = createRemoteNekConfigHostExecutor({
    id: "remote:box",
    runtime,
    connection: fake.connection,
  });
  await executor.spawnNek(["--mode", "rpc", "--control"]);
  const command = fake.commands.at(-1) ?? "";
  const [shell, flag, script = ""] = posixWords(command);
  assert.deepEqual([shell, flag], ["sh", "-lc"]);
  assert.deepEqual(posixWords(script), [
    "exec",
    NEK_INFO.node.path,
    ...NEK_INFO.launch.args,
    "--mode",
    "rpc",
    "--control",
  ]);
});

test("remote executor holds the remote lock around the settings read-modify-write", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection, NEK_INFO);
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
    .filter((command) => command.startsWith(`'${NEK_INFO.node.path}'`))
    .map((command) => base64PayloadOf(command)[0]);
  assert.deepEqual(operations.slice(0, 5), ["write", "lock", "read", "write", "unlock"]);
});

test("remote executor exposes remote command failures", async () => {
  const fake = fakeConnection({ fail: true });
  await assert.rejects(
    () => detectRemoteConfigRuntime(fake.connection, NEK_INFO),
    /remote failure/u,
  );
});

test("remote runtime detection fails loudly when gui-info has no node path", async () => {
  const fake = fakeConnection();
  await assert.rejects(
    () =>
      detectRemoteConfigRuntime(fake.connection, { ...NEK_INFO, node: { path: "", version: "" } }),
    /没有给出 Node 路径/u,
  );
});

test("remote executor backs settings reads and locked writes for a connected target", async () => {
  const fake = fakeConnection();
  const runtime = await detectRemoteConfigRuntime(fake.connection, NEK_INFO);
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
    await api.saveModelScope(target, ["acme/sonnet"], { expectedPatterns: [] });
    const remoteSettings = fake.files.get("/home/remote/.nek/agent/settings.json");
    assert.ok(remoteSettings, "the write must reach the POSIX path used by remote nek");
    assert.deepEqual(JSON.parse(remoteSettings).enabledModels, ["acme/sonnet"]);
    const operations = fake.commands
      .filter((command) => command.startsWith(`'${NEK_INFO.node.path}'`))
      .map((command) => base64PayloadOf(command)[0]);
    assert.equal(operations.includes("lock"), true);
    assert.equal(operations.includes("unlock"), true);
  } finally {
    api.dispose();
  }
});
