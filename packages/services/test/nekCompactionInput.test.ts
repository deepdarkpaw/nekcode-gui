/**
 * 压缩期间的 GUI 输入接纳：消息不能先发给 CLI 再显示 compaction error。
 *
 * CLI 的 `prompt` / `steer` / `follow_up` 在压缩中都会被拒绝或打乱压缩，因此 GUI 自己
 * 暂存待发送输入，压缩收口后才走正常发送入口；配置预提交（set_model 等）同样不能
 * 落在压缩期间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { command, harness, params, target } from "./nekSessionHarness.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const compactionEnd = {
  type: "compaction_end" as const,
  reason: "manual" as const,
  aborted: false,
  willRetry: false,
  result: { tokensBefore: 100 },
};

const sendTypes = new Set(["prompt", "steer", "follow_up"]);

function sentTypes(commands: readonly { type: string }[]): string[] {
  return commands.map((item) => item.type).filter((type) => sendTypes.has(type));
}

test("压缩期间 sendText 一条命令都不发，收口后按序提交一次", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0]!;
    session.emit({ type: "compaction_start", reason: "manual" });

    let settled = false;
    const ack = h.adapter
      .sendNekConversationCommandV4({
        target,
        envelope: {
          ...command,
          commandId: "queued-while-compacting",
          payload: {
            text: "压缩之后再说",
            modelSelection: { providerId: "acme", modelId: "acme-1" },
            requestedDelivery: "queue",
          },
        },
      })
      .finally(() => {
        settled = true;
      });

    await tick();
    assert.equal(settled, false);
    // 压缩中不触达 CLI：既不发送，也不预提交模型选择。
    assert.deepEqual(sentTypes(session.commands), []);
    assert.equal(
      session.commands.some((item) => item.type === "set_model"),
      false,
    );

    session.emit(compactionEnd);
    const result = await ack;
    assert.equal(result.status, "accepted");
    assert.deepEqual(sentTypes(session.commands), ["prompt"]);
    assert.deepEqual(
      session.commands.map((item) => item.type).filter((type) => type === "set_model"),
      ["set_model"],
    );
    // 预提交必须早于真正的发送：模型写入属于这次提交，而不是压缩期间。
    const types = session.commands.map((item) => item.type);
    assert.ok(types.indexOf("set_model") < types.indexOf("prompt"));
    const prompt = session.commands.find((item) => item.type === "prompt");
    assert.equal(prompt?.type === "prompt" && prompt.message, "压缩之后再说");
  } finally {
    await h.adapter.dispose();
  }
});

test("压缩中连发两条：顺序不变、各提交一次", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0]!;
    session.emit({ type: "compaction_start", reason: "manual" });
    const first = h.adapter.sendNekConversationCommandV4({
      target,
      envelope: { ...command, commandId: "a", payload: { text: "第一条" } },
    });
    const second = h.adapter.sendNekConversationCommandV4({
      target,
      envelope: { ...command, commandId: "b", payload: { text: "第二条" } },
    });
    await tick();
    assert.deepEqual(sentTypes(session.commands), []);

    session.emit(compactionEnd);
    const [ackA, ackB] = await Promise.all([first, second]);
    assert.equal(ackA.status, "accepted");
    assert.equal(ackB.status, "accepted");
    const messages = session.commands
      .map((item) => ("message" in item ? item.message : undefined))
      .filter((message) => message === "第一条" || message === "第二条");
    assert.deepEqual(messages, ["第一条", "第二条"]);
    // 第一条收口后起新一轮；第二条按默认 Enter 语义（guide → steer）插入这一轮，与 CLI 一致。
    assert.deepEqual(sentTypes(session.commands), ["prompt", "steer"]);
  } finally {
    await h.adapter.dispose();
  }
});

test("压缩被取消时 ACK 失败而不是假装接纳", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0]!;
    session.emit({ type: "compaction_start", reason: "manual" });
    const ack = h.adapter.sendNekConversationCommandV4({
      target,
      envelope: { ...command, commandId: "cancel-me", payload: { text: "不会被发送" } },
    });
    await tick();
    session.emit({ ...compactionEnd, aborted: true });
    await assert.rejects(ack, (error: Error) => error.name === "NekPendingInputCancelledError");
    assert.deepEqual(sentTypes(session.commands), []);
  } finally {
    await h.adapter.dispose();
  }
});
