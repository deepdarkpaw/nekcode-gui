import assert from "node:assert/strict";
import test from "node:test";
import { conversationOpenTimingSchema } from "@zcode/shared/zcode-protocol-v4";
import { harness, params, target } from "./nekSessionHarness.js";

async function waitForSnapshotRead(h: ReturnType<typeof harness>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (h.control.commands.some((command) => command.type === "read_session_snapshot")) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("snapshot read did not start");
}

test("OT-1: cold ACK carries measured restore/RPC spans through the existing timing contract", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.holdSnapshot();
  // 同步扇出消费者的耗时不属于编码耗时。
  h.adapter.onDynamicConversationFrame(target)(() => {
    now += 25;
  });
  try {
    const pending = h.adapter.subscribeConversationV4(params);
    await waitForSnapshotRead(h);
    now = 80;
    h.releaseSnapshot();
    const { ack } = await pending;
    const timing = conversationOpenTimingSchema.parse(ack.openTiming);
    assert.equal(timing.sessionRuntimeState, "cold");
    assert.equal(timing.cliProcessState, "spawned");
    assert.equal(timing.hostPrepareMs, 80);
    assert.equal(timing.cliSessionRestoreMs, 80);
    assert.equal(timing.cliRequestMs, 80);
    assert.equal(timing.cliBootstrapMs, 0);
    assert.equal(timing.taskMetaReadMs, 0);
    assert.equal(timing.initialFrameEncodeMs, 0);
    assert.equal(timing.snapshotRowCount, 2);
    assert.equal(now, 105);
    const full = await h.adapter.readNekSession(params);
    assert.equal("openTiming" in full, false, "diagnostics must not become conversation facts");
    const binding = await h.adapter.ensureNekSessionBinding(params, params.sessionId);
    assert.equal(binding.openTiming, undefined, "binding storage must not cache a cold timing");
  } finally {
    h.releaseSnapshot();
    await h.adapter.dispose();
  }
});

test("OT-2: a warm subscribe never reuses an earlier cold restore's timings", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.holdSnapshot();
  try {
    const pending = h.adapter.subscribeConversationV4(params);
    await waitForSnapshotRead(h);
    now = 70;
    h.releaseSnapshot();
    const first = await pending;
    assert.equal(first.ack.openTiming?.cliSessionRestoreMs, 70);
    now = 100;
    const second = await h.adapter.subscribeConversationV4(params);
    const warm = conversationOpenTimingSchema.parse(second.ack.openTiming);
    assert.equal(warm.sessionRuntimeState, "warm");
    assert.equal(warm.cliSessionRestoreMs, undefined);
    assert.equal(warm.cliRequestMs, undefined);
    assert.equal(warm.cliBootstrapMs, undefined);
    assert.equal(warm.taskMetaReadMs, undefined);
    assert.equal(warm.snapshotRowCount, 2);
    assert.equal(h.sessions.length, 1);
    assert.equal(
      h.control.commands.filter((command) => command.type === "read_session_snapshot").length,
      1,
    );
  } finally {
    h.releaseSnapshot();
    await h.adapter.dispose();
  }
});

test("OT-2: concurrent subscribers share one restore and only its in-flight timing", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.holdSnapshot();
  try {
    const first = h.adapter.subscribeConversationV4(params);
    const second = h.adapter.subscribeConversationV4(params);
    await waitForSnapshotRead(h);
    now = 40;
    h.releaseSnapshot();
    const results = await Promise.all([first, second]);
    assert.notEqual(results[0].ack.subscriptionId, results[1].ack.subscriptionId);
    for (const result of results) {
      const timing = conversationOpenTimingSchema.parse(result.ack.openTiming);
      assert.equal(timing.sessionRuntimeState, "cold");
      assert.equal(timing.cliSessionRestoreMs, 40);
      assert.equal(timing.cliRequestMs, 40);
    }
    assert.equal(h.sessions.length, 1);
    assert.equal(
      h.control.commands.filter((command) => command.type === "read_session_snapshot").length,
      1,
    );
    assert.equal(
      (await h.adapter.ensureNekSessionBinding(params, params.sessionId)).openTiming,
      undefined,
    );
  } finally {
    h.releaseSnapshot();
    await h.adapter.dispose();
  }
});

test("OT-3: a failed restore rejects and a retry reports only the successful attempt", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.holdSnapshot();
  h.failSnapshot(new Error("snapshot unavailable"));
  try {
    const failed = h.adapter.subscribeConversationV4(params);
    const rejected = assert.rejects(failed, /snapshot unavailable/u);
    await waitForSnapshotRead(h);
    now = 100;
    h.releaseSnapshot();
    await rejected;
    assert.equal(h.sessions.length, 0);
    h.failSnapshot();
    now = 200;
    const retry = await h.adapter.subscribeConversationV4(params);
    const timing = conversationOpenTimingSchema.parse(retry.ack.openTiming);
    assert.equal(timing.sessionRuntimeState, "cold");
    assert.equal(timing.cliSessionRestoreMs, 0);
    assert.equal(timing.cliRequestMs, 0);
    assert.equal(h.sessions.length, 1);
  } finally {
    h.releaseSnapshot();
    await h.adapter.dispose();
  }
});
