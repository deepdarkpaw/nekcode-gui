import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createRemoteNekConfigHostExecutor,
  readRemoteConfigPaths,
  type NekRemoteConfigConnection,
  type NekRemoteConfigExecStream,
} from "../src/nek-config-api/remoteHostExecutor.js";

function fakeConnection(options: { fail?: boolean } = {}): {
  connection: NekRemoteConfigConnection;
  commands: string[];
} {
  const commands: string[] = [];
  const connection: NekRemoteConfigConnection = {
    async exec(command): Promise<NekRemoteConfigExecStream> {
      commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners = new Set<(code: number) => void>();
      const payload = command.split(" ").at(-1)?.replace(/^'|'$/gu, "") ?? "";
      const [operation] = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as string[];
      const value =
        operation === "paths"
          ? { home: "/home/remote", agentDir: "/home/remote/.nek/agent" }
          : operation === "read"
            ? { content: "{}" }
            : operation === "stat"
              ? { mtimeMs: 1, size: 2, isDirectory: false }
              : operation === "listDir"
                ? [{ name: "settings.json", isDirectory: false }]
                : null;
      setImmediate(() => {
        if (options.fail) {
          stderr.end("remote failure");
          for (const listener of listeners) listener(1);
          return;
        }
        stdout.end(JSON.stringify({ ok: true, value }));
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
  return { connection, commands };
}

test("remote executor runs config primitives on a connected target", async () => {
  const fake = fakeConnection();
  const paths = await readRemoteConfigPaths(fake.connection);
  const executor = createRemoteNekConfigHostExecutor({
    id: "remote:box",
    ...paths,
    connection: fake.connection,
  });
  assert.equal(await executor.readFile("/home/remote/.nek/agent/settings.json"), "{}");
  assert.deepEqual(await executor.stat("/tmp/settings.json"), {
    mtimeMs: 1,
    size: 2,
    isDirectory: false,
  });
  assert.deepEqual(await executor.listDir("/tmp"), [{ name: "settings.json", isDirectory: false }]);
  await executor.writeFileAtomic("/tmp/settings.json", "{}");
  await executor.rename("/tmp/settings.json", "/tmp/settings.next.json");
  await executor.remove("/tmp/settings.next.json");
  assert.equal(fake.commands.length, 7);
});

test("remote executor exposes remote command failures", async () => {
  const fake = fakeConnection({ fail: true });
  await assert.rejects(() => readRemoteConfigPaths(fake.connection), /remote failure/u);
});
