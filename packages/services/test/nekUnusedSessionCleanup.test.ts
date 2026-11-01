import assert from "node:assert/strict";
import test from "node:test";
import type { NekRpcCommand } from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import { deleteUnusedCreatedSessions } from "../src/nek-agent/service/nekUnusedSessionCleanup.js";
import type { NekSessionRecord } from "../src/nek-agent/service/types.js";
import { harness, params, sessionPath, target } from "./nekSessionHarness.js";

function deletedPaths(commands: readonly NekRpcCommand[]): string[] {
  return commands.flatMap((command) =>
    command.type === "delete_session" ? [command.sessionPath] : [],
  );
}

// 草稿页的预热会话（或建好没发送的新任务）在退出前来不及被 renderer 删除；nek 已把它落盘。
test("shutdown deletes a session this run created that never received a message", async () => {
  const h = harness({ messageCount: 0 });
  await h.adapter.createNekSession(target);
  const session = h.sessions[0];
  assert.ok(session);
  await h.adapter.disposeAllAndWait();
  assert.deepEqual(deletedPaths(h.control.commands), [sessionPath]);
  assert.ok(session.isDisposed(), "the session process is closed before nek deletes the file");
});

test("shutdown keeps used sessions and sessions restored from disk", async () => {
  const created = harness({ messageCount: 1 });
  await created.adapter.createNekSession(target);
  await created.adapter.disposeAllAndWait();
  assert.deepEqual(deletedPaths(created.control.commands), []);

  const restored = harness({ messageCount: 0 });
  await restored.adapter.subscribeConversationV4(params);
  await restored.adapter.disposeAllAndWait();
  assert.deepEqual(deletedPaths(restored.control.commands), [], "only sessions created this run");
});

function record(key: string, call: () => Promise<unknown>): NekSessionRecord {
  const process = { client: { call } } as unknown as NekRpcProcess;
  return {
    key,
    sessionId: key,
    cwd: "/project",
    phase: "idle",
    readonly: false,
    closing: false,
    createdThisRun: true,
    process,
  };
}

test("one failing cleanup is logged and does not stop the others", async () => {
  const deleted: string[] = [];
  const warnings: unknown[][] = [];
  await deleteUnusedCreatedSessions(
    [
      record("broken", async () => await Promise.reject(new Error("process gone"))),
      record("empty", async () => ({ messageCount: 0, sessionFile: "/sessions/empty.sqlite" })),
    ],
    {
      deleteSession: async (input) => {
        deleted.push(input.sessionPath);
      },
      logger: { warn: (...args) => warnings.push(args) },
    },
  );
  assert.deepEqual(deleted, ["/sessions/empty.sqlite"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.[1], "broken");
});
