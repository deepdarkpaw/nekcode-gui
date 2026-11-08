/**
 * GUI 待发送输入队列：压缩期间的 pre-submit 暂存必须可撤销、有界、按序、且绝不再补发。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NekPendingInputCancelledError,
  NekPendingInputQueue,
} from "../src/nek-agent/service/nekPendingInputQueue.js";

const scope = { sessionKey: "session-a", sessionId: "id-a" };

function createQueue(options: Partial<{ maxPerSession: number; timeoutMs: number }> = {}) {
  return new NekPendingInputQueue({
    maxPerSession: options.maxPerSession ?? 4,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
}

test("收口后按入队顺序各执行一次", async () => {
  const queue = createQueue();
  const order: string[] = [];
  const first = queue.enqueue(scope, async () => {
    order.push("first");
    return 1;
  });
  const second = queue.enqueue(scope, async () => {
    order.push("second");
    return 2;
  });
  assert.equal(queue.pendingCount(scope.sessionKey), 2);
  await queue.drain(scope);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(queue.pendingCount(scope.sessionKey), 0);
  // 重复 drain 不会再执行一次。
  await queue.drain(scope);
  assert.deepEqual(order, ["first", "second"]);
});

test("同一任务失败只影响自己，后面的仍按序提交", async () => {
  const queue = createQueue();
  const first = queue.enqueue(scope, async () => {
    throw new Error("boom");
  });
  const second = queue.enqueue(scope, async () => "ok");
  await queue.drain(scope);
  await assert.rejects(first, /boom/u);
  assert.equal(await second, "ok");
});

test("会话换代后旧输入可见失败，不会回填到新会话", async () => {
  const queue = createQueue();
  let ran = false;
  const pending = queue.enqueue(scope, async () => {
    ran = true;
  });
  await queue.drain({ sessionKey: scope.sessionKey, sessionId: "id-b" });
  await assert.rejects(pending, (error: Error) => {
    assert.ok(error instanceof NekPendingInputCancelledError);
    assert.match(error.message, /会话已切换/u);
    return true;
  });
  assert.equal(ran, false);
});

test("撤回后的输入不会被 drain 补发", async () => {
  const queue = createQueue();
  let ran = false;
  const pending = queue.enqueue(scope, async () => {
    ran = true;
  });
  queue.cancel(scope.sessionKey, new NekPendingInputCancelledError("会话已关闭"));
  await assert.rejects(pending, /会话已关闭/u);
  await queue.drain(scope);
  assert.equal(ran, false);
});

test("超过单会话上限直接可见失败，不无界堆积", async () => {
  const queue = createQueue({ maxPerSession: 1 });
  const kept = queue.enqueue(scope, async () => "kept");
  await assert.rejects(
    queue.enqueue(scope, async () => "overflow"),
    /消息过多/u,
  );
  assert.equal(queue.pendingCount(scope.sessionKey), 1);
  await queue.drain(scope);
  assert.equal(await kept, "kept");
});

test("等待超时可见失败，之后的 drain 不会再提交", async () => {
  const queue = createQueue({ timeoutMs: 10 });
  let ran = false;
  const pending = queue.enqueue(scope, async () => {
    ran = true;
  });
  await assert.rejects(pending, /超时/u);
  await queue.drain(scope);
  assert.equal(ran, false);
});

test("收口期间新到的发送直接执行：不会二次排队自锁", async () => {
  const queue = createQueue();
  const gate = Promise.withResolvers<void>();
  const first = queue.enqueue(scope, async () => {
    await gate.promise;
    return "first";
  });
  const drained = queue.drain(scope);
  await Promise.resolve();
  assert.equal(queue.isDraining(scope.sessionKey), true);
  gate.resolve();
  await drained;
  assert.equal(await first, "first");
  assert.equal(queue.isDraining(scope.sessionKey), false);
});
