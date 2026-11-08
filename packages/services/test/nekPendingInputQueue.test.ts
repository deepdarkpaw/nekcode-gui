/**
 * GUI 待发送输入：排队阶段可撤回、提交阶段由真实 RPC 裁决，收口严格按 FIFO。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NekPendingInputCancelledError,
  NekPendingInputController,
} from "../src/nek-agent/service/nekPendingInputQueue.js";
import type { NekSessionRecord } from "../src/nek-agent/service/types.js";

function record(sessionId = "id-a"): NekSessionRecord {
  return {
    key: "session-a",
    sessionId,
    cwd: "/workspace",
    phase: "idle",
    readonly: false,
    state: {
      sessionId,
      isStreaming: false,
      isCompacting: false,
    } as NekSessionRecord["state"],
  };
}

function controller(timeoutMs = 1_000, maxPerSession = 4) {
  return new NekPendingInputController({
    maxPerSession,
    timeoutMs,
    withLease: async (_record, run) => await run(),
  });
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T>() => {
  const deferredValue = Promise.withResolvers<T>();
  return { ...deferredValue, promise: deferredValue.promise };
};

test("收口后按入队顺序各执行一次，重复 settle 不重复提交", async () => {
  const gate = controller();
  const target = record();
  const order: string[] = [];
  const first = gate.defer(target, async () => {
    order.push("first");
    return 1;
  });
  const second = gate.defer(target, async () => {
    order.push("second");
    return 2;
  });
  // 不在压缩中：defer 直接执行，不进队列。
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(gate.pendingCount(target.key), 0);

  target.state!.isCompacting = true;
  const queued = gate.defer(target, async () => {
    order.push("queued");
    return 3;
  });
  assert.equal(gate.pendingCount(target.key), 1);
  target.state!.isCompacting = false;
  gate.settle(target);
  gate.settle(target);
  assert.equal(await queued, 3);
  assert.deepEqual(order, ["first", "second", "queued"]);
});

test("第 1 项 ACK 未回时新输入排到队尾，不越过仍在提交的旧条目", async () => {
  const gate = controller();
  const target = record();
  target.state!.isCompacting = true;
  const order: string[] = [];
  const firstAck = deferred<void>();
  const first = gate.defer(target, async () => {
    order.push("first");
    await firstAck.promise;
    return "first";
  });
  const second = gate.defer(target, async () => {
    order.push("second");
    return "second";
  });
  target.state!.isCompacting = false;
  gate.settle(target);
  await tick();
  // 第 1 项的 ACK 还没回：这时来的新输入必须排队，而不是插到前面直接发。
  const third = gate.defer(target, async () => {
    order.push("third");
    return "third";
  });
  await tick();
  assert.deepEqual(order, ["first"]);
  assert.equal(gate.pendingCount(target.key), 2);
  firstAck.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(gate.pendingCount(target.key), 0);
});

test("收口期间再次进入压缩：剩余条目暂停，下一次收口各提交一次", async () => {
  const gate = controller();
  const target = record();
  target.state!.isCompacting = true;
  const order: string[] = [];
  const firstAck = deferred<void>();
  const first = gate.defer(target, async () => {
    order.push("first");
    await firstAck.promise;
    return "first";
  });
  const second = gate.defer(target, async () => {
    order.push("second");
    return "second";
  });
  target.state!.isCompacting = false;
  gate.settle(target);
  await tick();
  // 第 1 项还在提交时又开始了新的压缩：第 2 项必须停下等这次压缩收口。
  target.state!.isCompacting = true;
  firstAck.resolve();
  assert.equal(await first, "first");
  await tick();
  assert.deepEqual(order, ["first"]);
  assert.equal(gate.pendingCount(target.key), 1);
  target.state!.isCompacting = false;
  gate.settle(target);
  assert.equal(await second, "second");
  gate.settle(target);
  assert.deepEqual(order, ["first", "second"]);
});

test("等待计时只覆盖排队阶段：进入提交后 ACK 慢也不再伪称未发送", async () => {
  const gate = controller(20);
  const target = record();
  target.state!.isCompacting = true;
  const submitting = gate.defer(target, async () => {
    // 模拟 RPC 已提交、ACK 比排队超时更晚才回来。
    await tick(120);
    return "acked";
  });
  target.state!.isCompacting = false;
  gate.settle(target);
  // 进入提交后即便超过等待上限，结果仍由真实结果裁决。
  assert.equal(await submitting, "acked");
});

test("排队超过等待上限仍然可见失败（不提交、不补发）", async () => {
  const gate = controller(20);
  const target = record();
  target.state!.isCompacting = true;
  let ran = false;
  const queued = gate.defer(target, async () => {
    ran = true;
  });
  await assert.rejects(queued, (error: Error) => {
    assert.ok(error instanceof NekPendingInputCancelledError);
    assert.match(error.message, /超时/u);
    return true;
  });
  target.state!.isCompacting = false;
  gate.settle(target);
  await tick();
  assert.equal(ran, false);
});

test("会话换代：旧输入可见失败，绝不补发到新会话", async () => {
  const gate = controller();
  const target = record();
  target.state!.isCompacting = true;
  let ran = false;
  const queued = gate.defer(target, async () => {
    ran = true;
  });
  target.sessionId = "id-b";
  target.state!.isCompacting = false;
  gate.settle(target);
  await assert.rejects(queued, /会话已切换/u);
  assert.equal(ran, false);
});

test("撤回只作用于未提交条目：已在提交的那一条仍由真实结果裁决", async () => {
  const gate = controller();
  const target = record();
  target.state!.isCompacting = true;
  const ack = deferred<string>();
  const submitting = gate.defer(target, async () => await ack.promise);
  const queued = gate.defer(target, async () => "queued");
  target.state!.isCompacting = false;
  gate.settle(target);
  await tick();
  gate.cancel(target, new NekPendingInputCancelledError("会话已关闭"));
  await assert.rejects(queued, /会话已关闭/u);
  ack.resolve("submitted-result");
  assert.equal(await submitting, "submitted-result");
});

test("单会话上限与 cancelAll 都是有界可见失败", async () => {
  const gate = controller(1_000, 1);
  const target = record();
  target.state!.isCompacting = true;
  const kept = gate.defer(target, async () => "kept");
  await assert.rejects(
    gate.defer(target, async () => "overflow"),
    /消息过多/u,
  );
  assert.equal(gate.pendingCount(target.key), 1);
  gate.cancelAll(new NekPendingInputCancelledError("service disposed"));
  await assert.rejects(kept, /service disposed/u);
  assert.equal(gate.pendingCount(target.key), 0);
});
