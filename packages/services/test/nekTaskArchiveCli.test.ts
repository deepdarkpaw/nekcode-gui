import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import { createNekRpcProcess, type NekRpcProcessOptions } from "../src/nek-agent/nekRpcProcess.js";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import { importConversationArchive } from "../../ui/src/lib/importConversationArchive.js";
import { saveConversationExport } from "../../ui/src/lib/saveConversationExport.js";

const guiInfoPath = process.env.NEK_ARCHIVE_E2E_GUI_INFO;
const temp = resolve(".tmp");

function assertIsolated(path: string | undefined) {
  assert.ok(
    path && isAbsolute(path),
    "Set every home and nek path to an absolute path under worktree/.tmp",
  );
  const subpath = relative(temp, path);
  assert.ok(
    subpath && !subpath.startsWith("..") && !isAbsolute(subpath),
    "Expected an isolated .tmp path",
  );
}

function sourceEntries(cwd: string) {
  const timestamp = "2026-10-28T12:00:00.000Z";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = {
    role: "assistant",
    api: "openai-completions",
    provider: "fixture-no-network",
    model: "never-called",
    usage,
    stopReason: "stop",
    timestamp: Date.parse(timestamp),
  };
  const message = (id: string, parentId: string | null, data: object) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { timestamp: Date.parse(timestamp), ...data },
  });
  return [
    { type: "session", version: 3, id: "na-source-fixture", timestamp, cwd },
    message("u-1", null, {
      role: "user",
      content: [{ type: "text", text: "Read the archive fixture 归档" }],
    }),
    message("other-branch", "u-1", {
      ...assistant,
      content: [{ type: "text", text: "Not on the exported branch" }],
    }),
    message("a-1", "u-1", {
      ...assistant,
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "read-fixture", name: "read", arguments: { path: "fixture.txt" } },
      ],
    }),
    message("t-1", "a-1", {
      role: "toolResult",
      toolCallId: "read-fixture",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "Fixture tool result" }],
    }),
    message("a-2", "t-1", {
      ...assistant,
      content: [{ type: "text", text: "Fixture assistant reply" }],
    }),
  ];
}

/** Opt-in: run under env -i with isolated HOME/USERPROFILE/NEK_CODING_AGENT_* and NEK_OFFLINE=1. */
test(
  "NA-7 exact nek CLI native export → renderer upload → index/writable reopen → native re-export",
  {
    skip: !guiInfoPath && "Set NEK_ARCHIVE_E2E_GUI_INFO to an isolated nek gui-info JSON file",
    timeout: 90_000,
  },
  async () => {
    assertIsolated(guiInfoPath);
    for (const name of [
      "HOME",
      "USERPROFILE",
      "NEK_CODING_AGENT_DIR",
      "NEK_CODING_AGENT_SESSION_DIR",
    ])
      assertIsolated(process.env[name]);
    assert.equal(process.env.NEK_OFFLINE, "1");
    const info = JSON.parse(await readFile(guiInfoPath!, "utf8")) as NekGuiInfo;
    assertIsolated(info.agentDir);
    assertIsolated(info.sessionDir);
    const root = await mkdtemp(join(temp, "na-native-"));
    const cwd = join(root, "project");
    const taskArchiveStagingDir = join(root, "stage");
    await mkdir(cwd);
    const seed = sourceEntries(cwd);
    const seedPath = join(root, "source-fixture.jsonl");
    await writeFile(seedPath, seed.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const rpc: string[] = [];
    const processFor = (options: NekRpcProcessOptions) => {
      const proc = createNekRpcProcess({ ...options, extraArgs: ["--offline", "--no-extensions"] });
      const original = proc.client.call.bind(proc.client);
      proc.client.call = (command, options) => {
        assert.ok(
          !["prompt", "steer", "follow_up", "compact"].includes(command.type),
          "No model commands in this test",
        );
        rpc.push(command.type);
        return original(command, options);
      };
      return proc;
    };
    const adapter = createNekAgentServiceAdapter({
      guiInfo: info,
      cwd,
      taskArchiveStagingDir,
      askProjectTrust: () => "deny",
      createControlProcess: () => processFor({ guiInfo: info, cwd, control: true }),
      createSessionProcess: (request) =>
        processFor({
          guiInfo: info,
          cwd: request.cwd,
          sessionPath: request.sessionPath,
          approve: false,
        }),
    });
    const scope = createZCodeAgentConnectionScope(adapter, {
      connectionId: "na-native-gui",
      clientMode: "desktop-continuous",
    });
    const target = { workspacePath: cwd };
    const call = scope.service.nekTaskArchive;
    async function exportThroughGui(id: string, name: string) {
      const reply = await call({ ...target, action: "export", sessionId: id });
      assert.equal(reply.action, "export");
      assert.match(reply.archive.suggestedName, /\.jsonl$/u);
      const path = join(root, name);
      await saveConversationExport(
        {
          async readExportChunk(archiveId, offset) {
            const chunk = await call({ ...target, action: "readExport", archiveId, offset });
            assert.equal(chunk.action, "readExport");
            return chunk.data;
          },
          releaseExport: (archiveId) => call({ ...target, action: "release", archiveId }),
        },
        {
          saveFile: async ({ data }) => {
            assert.ok(data);
            await writeFile(path, new Uint8Array(data));
            return { success: true };
          },
        },
        reply.archive,
      );
      return new Uint8Array(await readFile(path));
    }
    const frames: string[][] = [];
    const subscription = adapter.onDynamicSessionsIndexFrame(target)((event) => {
      if (event.kind === "complete" && event.frame.payload.kind === "snapshot") {
        frames.push(event.frame.payload.snapshot.sessions.map((s) => s.sessionId));
      }
    });
    try {
      const seeded = await adapter.service.importSession({ inputPath: seedPath, cwd });
      const original = (await adapter.listNekSessions(target)).find(
        (item) => item.path === seeded.sessionPath,
      );
      assert.ok(original);
      const initial = await exportThroughGui(original.id, "native-export.jsonl");
      const expected = seed.filter(
        (entry) => entry.type === "message" && entry.id !== "other-branch",
      );
      const entries = (bytes: Uint8Array) =>
        new TextDecoder()
          .decode(bytes)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      assert.deepEqual(
        entries(initial)
          .slice(1)
          .filter((entry) => entry.type === "message"),
        expected,
      );
      await adapter.subscribeSessionsIndexV4(target);
      const imported = await importConversationArchive(
        call,
        target,
        initial.buffer,
        () => {},
        () => {},
      );
      assert.notEqual(imported, original.id);
      for (let i = 0; i < 60 && !frames.some((ids) => ids.includes(imported)); i++) await delay(50);
      assert.ok(
        frames.some((ids) => ids.includes(imported)),
        "catalog_changed refreshes the existing GUI index subscription",
      );
      const snapshot = await adapter.readNekSession({ ...target, sessionId: imported });
      assert.equal(snapshot.control.readOnly, undefined);
      assert.equal(snapshot.sessionId, imported);
      assert.ok(snapshot.rows.totalCount > 0);
      const roundTrip = await exportThroughGui(imported, "reopened-export.jsonl");
      const importedEntries = entries(roundTrip);
      assert.equal(importedEntries[0].id, imported);
      assert.deepEqual(
        importedEntries.slice(1).filter((entry) => entry.type === "message"),
        expected,
      );
      assert.deepEqual(await readdir(taskArchiveStagingDir), []);
      assert.equal(rpc.filter((type) => type === "import_session").length, 2); // one source fixture, one GUI import
      assert.equal(rpc.filter((type) => type === "export_session").length, 2);
      assert.ok(rpc.includes("list_sessions"));
      console.log(
        JSON.stringify({
          version: info.nekVersion,
          original: original.id,
          imported,
          messages: expected.length,
          bytes: initial.length,
          reopened: snapshot.sessionId,
          indexRefreshed: true,
          contents: ["user", "assistant", "toolResult"],
          unselectedBranchExported: false,
          rpc,
          artifacts: root,
        }),
      );
    } finally {
      subscription.dispose();
      await scope.dispose();
      await adapter.dispose();
    }
  },
);
