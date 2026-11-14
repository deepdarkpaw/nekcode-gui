import assert from "node:assert/strict";
import test from "node:test";
import { harness, params, sessionPath, target } from "./nekSessionHarness.js";

test("HS1: refreshing a known readonly history uses its trusted path, not an unrelated full catalog", async () => {
  const h = harness({
    lockedBy: { pid: process.pid, hostname: "fixture", kind: "rpc", startedAt: "2026-11-01" },
  });
  try {
    await h.adapter.resumeNekSession({ ...target, sessionPath });
    h.adapter.listNekSessions = async () => {
      throw new Error("known session must not query full catalog");
    };
    const result = await h.adapter.subscribeConversationV4(params);
    assert.ok(result.ack.subscriptionId);
    assert.equal(h.sessions.length, 0);
  } finally {
    await h.adapter.dispose();
  }
});

test("HS4: a replaced file cannot publish another session under an existing readonly binding", async () => {
  const h = harness({
    lockedBy: { pid: process.pid, hostname: "fixture", kind: "rpc", startedAt: "2026-11-01" },
  });
  try {
    await h.adapter.resumeNekSession({ ...target, sessionPath });
    const before = await h.adapter.readNekSession(params);
    const original = h.control.process.client.call.bind(h.control.process.client);
    h.control.process.client.call = (async (command) => {
      const result = await original(command);
      if (command.type !== "read_session_metadata") return result;
      const metadata = result as { session: Record<string, unknown> };
      return { ...metadata, session: { ...metadata.session, id: "foreign-session" } };
    }) as typeof h.control.process.client.call;
    await assert.rejects(h.adapter.subscribeConversationV4(params), /identity changed/);
    assert.deepEqual((await h.adapter.readNekSession(params)).rows, before.rows);
  } finally {
    await h.adapter.dispose();
  }
});
