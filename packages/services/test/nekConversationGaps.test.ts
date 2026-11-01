import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDelta,
  conversationSnapshotSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { command, entry, harness, params, target } from "./nekSessionHarness.js";

const errorEvent = {
  type: "extension_error" as const,
  extensionPath: "/extensions/broken.ts",
  event: "tool_call",
  error: "handler exploded",
};
function errors(snapshot: ConversationSnapshot) {
  return snapshot.rows.window.flatMap((row) =>
    row.kind === "timelineMarker" && row.marker.type === "extensionError" ? row.marker.errors : [],
  );
}

test("extension failures render live, survive entry refresh, and replay identical notice rows", () => {
  const projector = new NekConversationProjector({ sessionId: "s", schedule: () => () => {} });
  const frames: ConversationTopicFrame[] = [];
  projector.loadSnapshot({ entries: [entry], leafId: entry.id });
  projector.subscribe((frame) => frames.push(frame));
  projector.handleEvent(errorEvent);
  projector.flushNow();
  projector.handleEvent(errorEvent);
  projector.flushNow();
  let replay = frames[0]!.payload.kind === "snapshot" ? frames[0]!.payload.snapshot : null;
  assert.ok(replay);
  for (const frame of frames.slice(1)) {
    if (frame.payload.kind === "snapshot") replay = frame.payload.snapshot;
    else for (const delta of frame.payload.deltas) replay = applyConversationDelta(replay, delta);
  }
  assert.deepEqual(
    errors(replay),
    [{ ...errorEvent, type: undefined, count: 2 }].map(({ type: _, ...notice }) => notice),
  );
  assert.deepEqual(errors(replay), errors(projector.snapshot()));
  projector.loadSnapshot({ entries: [entry], leafId: entry.id });
  assert.deepEqual(
    errors(projector.snapshot()),
    errors(replay),
    "settled refresh must not erase RPC-only errors",
  );
  const late: ConversationTopicFrame[] = [];
  projector.subscribe((frame) => late.push(frame));
  assert.equal(late[0]?.payload.kind, "snapshot");
  if (late[0]?.payload.kind === "snapshot")
    assert.deepEqual(errors(late[0].payload.snapshot), errors(replay));
  assert.equal(conversationSnapshotSchema.safeParse(projector.snapshot()).success, true);
  projector.dispose();
});

test("looping extensions use one bounded notice row, capped strings and collapsed repeats", () => {
  const projector = new NekConversationProjector({ sessionId: "s", schedule: () => () => {} });
  for (let i = 0; i < 1000; i++) projector.handleEvent(errorEvent);
  assert.equal(projector.rows.window.length, 1);
  assert.equal(errors(projector.snapshot())[0]?.count, 1000);
  for (let i = 0; i < 100; i++)
    projector.handleEvent({ ...errorEvent, error: `${i}:${"x".repeat(9000)}` });
  assert.equal(projector.rows.window.length, 1);
  assert.equal(errors(projector.snapshot()).length, 20);
  assert.ok(errors(projector.snapshot()).every((notice) => notice.error.length <= 8192));
  projector.dispose();
});

test("extension errors do not turn a healthy process into a failed session requiring restore", async () => {
  const h = harness();
  try {
    await h.adapter.readNekSession(params);
    h.sessions[0]!.emit(errorEvent);
    assert.equal(errors(await h.adapter.readNekSession(params)).length, 1);
    const binding = await h.adapter.ensureNekSessionBinding(target, params.sessionId);
    assert.equal(h.adapter.service.getSession(binding.sessionKey)?.phase, "idle");
    assert.equal(
      h.control.commands.filter((item) => item.type === "read_session_snapshot").length,
      1,
    );
    assert.equal(h.sessions.length, 1);
  } finally {
    await h.adapter.dispose();
  }
});

test("locked snapshot projects holder and rejected routing; subscription retry admits writes after release", async () => {
  const holder = {
    pid: 42,
    hostname: "other-host",
    kind: "rpc" as const,
    startedAt: entry.timestamp,
  };
  const h = harness({ lockedBy: holder });
  try {
    const first = await h.adapter.subscribeConversationV4(params);
    const locked = await h.adapter.readNekSession(params);
    assert.deepEqual(locked.control.readOnly, { reason: "locked", holder });
    assert.deepEqual(locked.inputRouting, { mode: "reject", reasonCode: "guard.sessionLocked" });
    assert.equal(locked.availability.fork.allowed, false);
    await assert.rejects(
      h.adapter.sendNekConversationCommandV4({ target, envelope: command }),
      /read-only/u,
    );
    await h.adapter.unsubscribeConversationV4({
      ...params,
      subscriptionId: first.ack.subscriptionId,
    });
    h.releaseLock();
    await h.adapter.subscribeConversationV4(params);
    const writable = await h.adapter.readNekSession(params);
    assert.equal(writable.control.readOnly, undefined);
    assert.equal(writable.inputRouting.mode, "startNow");
    await h.adapter.sendNekConversationCommandV4({ target, envelope: command });
    assert.ok(h.sessions[0]?.commands.some((item) => item.type === "prompt"));
  } finally {
    await h.adapter.dispose();
  }
});

test("locked retry still explains a held lock, and restore failures remain retryable", async () => {
  const holder = { pid: 42, hostname: "host", kind: "tui" as const, startedAt: entry.timestamp };
  const h = harness({ lockedBy: holder });
  try {
    await h.adapter.subscribeConversationV4(params);
    await h.adapter.subscribeConversationV4(params);
    assert.deepEqual((await h.adapter.readNekSession(params)).control.readOnly?.holder, holder);
    assert.equal(h.sessions.length, 0);
    h.failSnapshot(new Error("cannot read snapshot"));
    await assert.rejects(h.adapter.subscribeConversationV4(params), /cannot read snapshot/u);
    h.failSnapshot();
    h.releaseLock();
    await h.adapter.subscribeConversationV4(params);
    assert.equal((await h.adapter.readNekSession(params)).control.readOnly, undefined);
  } finally {
    await h.adapter.dispose();
  }
});
