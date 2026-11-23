import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { CONVERSATION_ARCHIVE_CHUNK_BYTES, CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import type { NekTaskArchiveRequest } from "@zcode/shared/nek-protocol";
import { createNekTaskArchive } from "../src/nek-agent/adapter/nekTaskArchive.js";
import { NekRpcCommandError } from "../src/nek-agent/nekRpcErrors.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

type Ports = Parameters<typeof createNekTaskArchive>[0];
async function fixture(t: TestContext) {
  const temp = resolve(".tmp");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "na-test-"));
  const stagingDir = join(root, "target-host-stage");
  const target = { workspacePath: root, workspaceIdentity: "ssh-fixture" };
  const path = join(root, "native-result.jsonl");
  const timestamp = "2026-11-24T00:00:00.000Z";
  const bytes = Buffer.from(
    [
      JSON.stringify({ type: "session", id: "original", version: 3, cwd: root, timestamp }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "测试" + "x".repeat(CONVERSATION_ARCHIVE_CHUNK_BYTES) },
      }),
    ].join("\n") + "\n",
  );
  const calls: Array<readonly unknown[]> = [];
  let readonly = false;
  let hasRows = true;
  let indexed = true;
  const service = {
    getSession: () => ({ readonly }) as ReturnType<Ports["service"]["getSession"]>,
    conversationSnapshot: () =>
      ({ rows: { totalCount: Number(hasRows) }, meta: { title: "fixture task" } }) as ReturnType<
        Ports["service"]["conversationSnapshot"]
      >,
    exportSession: async ({ sessionKey, format, outputPath }) => {
      calls.push([sessionKey, format, outputPath]);
      assert.ok(outputPath);
      assert.equal(dirname(dirname(outputPath)), stagingDir);
      await writeFile(outputPath, bytes);
      return { path: outputPath };
    },
    importSession: async ({ cwd, inputPath }) => {
      calls.push([cwd, inputPath]);
      assert.equal(dirname(dirname(inputPath)), stagingDir);
      assert.deepEqual(await readFile(inputPath), bytes);
      return { sessionPath: path };
    },
    listSessions: async ({ cwd }) => {
      calls.push(["index", cwd]);
      return indexed
        ? [
            {
              path,
              id: "new-native-id",
              cwd: root,
              createdAt: timestamp,
              modifiedAt: timestamp,
              messageCount: 1,
              firstMessage: "测试",
              locked: false,
            },
          ]
        : [];
    },
  } satisfies Ports["service"];
  const archive = createNekTaskArchive({
    service,
    stagingDir,
    ensureBinding: async (boundTarget, sessionId) => ({
      sessionKey: "live-session-key",
      target: boundTarget,
      sessionId,
      sessionPath: path,
    }),
  });
  const base = {
    nekTaskArchive: archive.run,
    setConnectionFlowStateV4: async (input: unknown) => {
      // Exercise the closure using the same trusted context propagation as the production adapter.
      const context = readTrustedZCodeAgentV4Connection(input);
      if (context) archive.closeConnection(context.connectionId);
    },
  } as IZCodeAgentService;
  const relay = createZCodeAgentConnectionScope(base, {
    connectionId: "ssh-target",
    clientMode: "desktop-continuous",
    role: "trusted-host-relay",
  });
  const first = createZCodeAgentConnectionScope(relay.service, {
    connectionId: "window-first",
    clientMode: "desktop-continuous",
  });
  const second = createZCodeAgentConnectionScope(relay.service, {
    connectionId: "window-second",
    clientMode: "desktop-continuous",
  });
  const mobile = createZCodeAgentConnectionScope(relay.service, {
    connectionId: "web",
    clientMode: "web-remote-replayable",
  });
  t.after(async () => {
    await first.dispose();
    await second.dispose();
    await mobile.dispose();
    await relay.dispose();
    archive.dispose();
    await rm(root, { force: true, recursive: true });
  });
  const call = first.service.nekTaskArchive;
  async function upload(data: Buffer) {
    const result = await call({ ...target, action: "beginImport", byteLength: data.byteLength });
    assert.equal(result.action, "beginImport");
    const transfer = { ...target, archiveId: result.archiveId };
    for (let offset = 0; offset < data.length; offset += CONVERSATION_ARCHIVE_CHUNK_BYTES) {
      await call({
        ...transfer,
        action: "appendImport",
        offset,
        data: data.subarray(offset, offset + CONVERSATION_ARCHIVE_CHUNK_BYTES).toString("base64"),
      });
    }
    return transfer;
  }
  return {
    stagingDir,
    target,
    bytes,
    calls,
    service,
    upload,
    call,
    first,
    second: second.service.nekTaskArchive,
    mobile: mobile.service.nekTaskArchive,
    setReadonly: () => {
      readonly = true;
    },
    setEmpty: () => {
      readonly = false;
      hasRows = false;
    },
    unindex: () => {
      indexed = false;
    },
  };
}

test("NA-1/3 export returns only native output, in owned bounded chunks, through the trusted relay", async (t) => {
  const f = await fixture(t);
  const result = await f.call({ ...f.target, action: "export", sessionId: "native" });
  assert.equal(result.action, "export");
  assert.equal(result.archive.suggestedName, "task-fixture task.jsonl");
  assert.deepEqual(f.calls[0]?.slice(0, 2), ["live-session-key", "jsonl"]);
  assert.equal(result.archive.byteLength, f.bytes.length);
  const transfer = {
    ...f.target,
    action: "readExport",
    archiveId: result.archive.archiveId,
    offset: 0,
  } as const;
  await assert.rejects(f.second(transfer));
  await assert.rejects(f.call({ ...transfer, workspaceIdentity: "other-target" }));
  const chunks = [];
  for (let offset = 0; offset < f.bytes.length; offset += CONVERSATION_ARCHIVE_CHUNK_BYTES) {
    const chunk = await f.call({ ...transfer, offset });
    assert.equal(chunk.action, "readExport");
    chunks.push(Buffer.from(chunk.data, "base64"));
  }
  assert.equal(chunks.length, 2);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  assert.deepEqual(await readdir(f.stagingDir), []);
  await f.call({ ...f.target, action: "release", archiveId: result.archive.archiveId });
  await assert.rejects(f.call(transfer));
});

test("NA-2/7 imports on the target, queries its native index, never commits a handle twice", async (t) => {
  const f = await fixture(t);
  const transfer = await f.upload(f.bytes);
  const commit = { ...transfer, action: "import" } as const;
  await assert.rejects(f.second(commit));
  const pending = f.call(commit);
  await assert.rejects(f.call(commit));
  assert.deepEqual(await pending, { action: "import", sessionId: "new-native-id" });
  await assert.rejects(f.call(commit));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]?.[0], f.target.workspacePath);
  assert.deepEqual(f.calls[1], ["index", f.target.workspacePath]);
  assert.deepEqual(await readdir(f.stagingDir), []);
});

test("NA-3/7 cancellation and disconnect release all owned uncommitted handles; no model or CLI import", async (t) => {
  const f = await fixture(t);
  const transfer = await f.upload(f.bytes);
  await f.call({ ...transfer, action: "release" });
  await assert.rejects(f.call({ ...transfer, action: "import" }));
  const abandoned = { ...f.target, action: "beginImport", byteLength: 8 } as const;
  await f.call(abandoned);
  await f.call({ ...abandoned, workspaceIdentity: "second-workspace" });
  await assert.rejects(f.second(abandoned));
  await assert.rejects(f.mobile(abandoned), /taskArchive.unavailable/u);
  await f.first.dispose();
  assert.equal((await f.second(abandoned)).action, "beginImport");
  assert.equal((await f.second(abandoned)).action, "beginImport");
  assert.deepEqual(f.calls, []);
});

test("NA-4/7 rejects legacy, malformed, empty/metadata-only and oversized input before nek", async (t) => {
  const f = await fixture(t);
  for (const bytes of [
    Buffer.from([80, 75, 3, 4]),
    Buffer.concat([f.bytes, Buffer.from("{broken")]),
    Buffer.from('{"type":"session"}\n'),
  ]) {
    await assert.rejects(
      f.call({ ...(await f.upload(bytes)), action: "import" }),
      /taskArchive.invalidFile/u,
    );
  }
  await assert.rejects(f.call({ ...f.target, action: "beginImport", byteLength: 0 }));
  await assert.rejects(
    f.call({
      ...f.target,
      action: "beginImport",
      byteLength: CONVERSATION_ARCHIVE_LIMITS.archiveBytes + 1,
    }),
    /taskArchive.limitExceeded/u,
  );
  assert.deepEqual(f.calls, []);
});

test("NA-7 export rejects locked or empty tasks without calling nek export", async (t) => {
  const f = await fixture(t);
  const request: NekTaskArchiveRequest = { ...f.target, action: "export", sessionId: "native" };
  f.setReadonly();
  await assert.rejects(f.call(request), /taskArchive.taskLocked/u);
  f.setEmpty();
  await assert.rejects(f.call(request), /taskArchive.noTask/u);
  assert.deepEqual(f.calls, []);
});

test("NA-7 export validates native output path and bound before reading; errors remove staged files", async (t) => {
  const f = await fixture(t);
  const request: NekTaskArchiveRequest = { ...f.target, action: "export", sessionId: "native" };
  f.service.exportSession = async () => ({
    path: join(f.target.workspacePath, "arbitrary-output.jsonl"),
  });
  await assert.rejects(f.call(request), /taskArchive.invalidExportPath/u);
  f.service.exportSession = async ({ outputPath }) => {
    assert.ok(outputPath);
    await writeFile(outputPath, "");
    await truncate(outputPath, CONVERSATION_ARCHIVE_LIMITS.archiveBytes + 1);
    return { path: outputPath };
  };
  await assert.rejects(f.call(request), /taskArchive.limitExceeded/u);
  f.service.exportSession = async () => {
    throw Object.assign(new Error("permission fixture"), { code: "EACCES" });
  };
  await assert.rejects(f.call(request), /taskArchive.permissionDenied/u);
  assert.deepEqual(await readdir(f.stagingDir), []);
});

test("NA-7 distinguishes CLI rejection, uncertain commit and imported-but-unindexed; no automatic replay", async (t) => {
  const f = await fixture(t);
  const native = f.service.importSession;
  f.service.importSession = async () => {
    throw new NekRpcCommandError("import_session", "rejected");
  };
  await assert.rejects(
    f.call({ ...(await f.upload(f.bytes)), action: "import" }),
    /taskArchive.importRejected/u,
  );
  f.service.importSession = async () => {
    throw new Error("transport disconnected");
  };
  const unknown = { ...(await f.upload(f.bytes)), action: "import" } as const;
  await assert.rejects(f.call(unknown), /taskArchive.importUnknown/u);
  await assert.rejects(f.call(unknown), /transfer is unavailable/u);
  f.service.importSession = native;
  f.unindex();
  await assert.rejects(
    f.call({ ...(await f.upload(f.bytes)), action: "import" }),
    /taskArchive.importedButNotIndexed/u,
  );
  assert.deepEqual(await readdir(f.stagingDir), []);
});
