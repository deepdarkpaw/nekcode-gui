import assert from "node:assert/strict";
import test from "node:test";
import { command, harness, params, target } from "./nekSessionHarness.js";

const selection = (reasoningLevel?: string) => ({
  providerId: "CPA",
  modelId: "claude-opus-5-5",
  ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
});

for (const level of ["max", "xhigh", "off"]) {
  test(`T1: create first input preserves canonical ${level} over legacy thought`, async () => {
    const h = harness();
    try {
      await h.adapter.sendNekConversationCommandV4({
        target,
        envelope: {
          ...command,
          sessionId: null,
          type: "createSession",
          payload: {
            firstInput: { text: "hello", modelSelection: selection(level) },
            config: { thought: "high", modelSelection: selection("high") },
          },
        },
      });
      assert.deepEqual(
        h.sessions[0]!.commands.filter((c) =>
          ["set_model", "set_thinking_level", "prompt"].includes(c.type),
        ).map(({ id: _id, ...c }) => c),
        [
          { type: "set_model", provider: "CPA", modelId: "claude-opus-5-5" },
          { type: "set_thinking_level", level },
          // 空闲首发也带 streamingBehavior：GUI 观察到 idle 之后 nek 仍可能已开跑，
          // 缺省会因此被拒绝；nek 空闲时忽略该字段。
          { type: "prompt", message: "hello", streamingBehavior: "followUp" },
        ],
      );
    } finally {
      await h.adapter.dispose();
    }
  });

  test(`T1: prewarmed and busy sends apply ${level} before prompt/steer`, async () => {
    const h = harness();
    try {
      await h.adapter.subscribeConversationV4(params);
      for (const [index, thinking] of [level, "high", level].entries()) {
        const before = h.sessions[0]!.commands.length;
        await h.adapter.sendNekConversationCommandV4({
          target,
          envelope: {
            ...command,
            commandId: `send-${index}`,
            payload: {
              text: "hello",
              modelSelection: selection(thinking),
            },
          },
        });
        const commands = h.sessions[0]!.commands.slice(before);
        const types = commands.map((c) => c.type);
        assert.ok(types.indexOf("set_model") < types.indexOf("set_thinking_level"));
        assert.equal(commands.find((c) => c.type === "set_thinking_level")?.level, thinking);
        assert.equal(types.at(-1), index === 0 ? "prompt" : "steer");
      }
    } finally {
      await h.adapter.dispose();
    }
  });
}

test("T2: missing thinking keeps nek default; invalid thinking rejects before side effects", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    await h.adapter.sendNekConversationCommandV4({
      target,
      envelope: { ...command, payload: { text: "hello", modelSelection: selection() } },
    });
    assert.equal(
      h.sessions[0]!.commands.some((c) => c.type === "set_thinking_level"),
      false,
    );
    const before = h.sessions[0]!.commands.length;
    await assert.rejects(
      h.adapter.sendNekConversationCommandV4({
        target,
        envelope: { ...command, payload: { text: "no", modelSelection: selection("invalid") } },
      }),
      /invalid nek thinking level/,
    );
    assert.equal(h.sessions[0]!.commands.length, before);
  } finally {
    await h.adapter.dispose();
  }
});
