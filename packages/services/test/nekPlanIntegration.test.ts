import assert from "node:assert/strict";
import test from "node:test";
import type { NekCustomMessage, NekCustomMessageEntry } from "@zcode/shared/nek-protocol";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { harness, command, params, target } from "./nekSessionHarness.js";

for (const firstInput of [true, false]) {
  test(`P1: GUI agent + planEnabled reaches nek as Plan before prompt (firstInput=${firstInput})`, async () => {
    const h = harness();
    try {
      if (!firstInput) await h.adapter.subscribeConversationV4(params);
      await h.adapter.sendNekConversationCommandV4({
        target,
        envelope: {
          ...command,
          ...(firstInput
            ? {
                sessionId: null,
                type: "createSession",
                payload: {
                  config: { mode: "agent" },
                  firstInput: { text: "plan first", mode: "agent", planEnabled: true },
                },
              }
            : { payload: { text: "plan first", mode: "agent", planEnabled: true } }),
        },
      });
      const sent = h.sessions[0]!.commands;
      const planIndex = sent.findIndex(
        (c) =>
          c.type === "extension_call" &&
          c.method === "nek.set_mode" &&
          (c.params as { mode: string }).mode === "plan",
      );
      assert.ok(planIndex >= 0);
      assert.ok(planIndex < sent.findIndex((c) => c.type === "prompt"));
      await h.adapter.sendNekConversationCommandV4({
        target,
        envelope: { ...command, payload: { text: "execute", mode: "agent", planEnabled: false } },
      });
      const modes = h.sessions[0]!.commands.flatMap((c) =>
        c.type === "extension_call" && c.method === "nek.set_mode"
          ? [(c.params as { mode: string }).mode]
          : [],
      );
      assert.deepEqual(modes, ["plan", "agent"]);
    } finally {
      await h.adapter.dispose();
    }
  });
}

test("P5: accepted mode transitions update composer facts once; ordinary state refresh preserves the marker", () => {
  const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
  try {
    const state = { mode: "plan" as const, todos: [], plans: [], subagents: [] };
    p.loadSnapshot({ entries: [], nekState: state });
    assert.equal(p.snapshot().config.planEnabled, true);
    p.applyNekState({ ...state, mode: "agent" });
    const accepted = p.snapshot().config;
    assert.equal(accepted.mode, "agent");
    assert.equal(accepted.planTransition?.planEnabled, false);
    p.applyNekState({ ...state, mode: "agent" });
    p.loadSnapshot({ entries: [], nekState: { ...state, mode: "agent" } });
    assert.deepEqual(p.snapshot().config.planTransition, accepted.planTransition);
    p.handleEvent({ type: "extension_event", name: "nek.state", payload: state });
    assert.equal(p.snapshot().config.planEnabled, true);
    assert.notEqual(
      p.snapshot().config.planTransition?.toolCallId,
      accepted.planTransition?.toolCallId,
    );
  } finally {
    p.dispose();
  }
});

test("P4: live and historical plan previews retain markdown, file path and standard plan-card identity", () => {
  const details = {
    plan: {
      name: "Plan",
      path: "G:/project/.nek/plans/feature.plan.md",
      revision: 2,
      overview: "Overview",
    },
    markdown: "# Plan\n\n- Do the work",
  };
  const message: NekCustomMessage = {
    role: "custom",
    customType: "nek.plan_preview",
    content: "Plan",
    display: true,
    details,
    timestamp: 1000,
  };
  const entry: NekCustomMessageEntry = {
    type: "custom_message",
    id: "plan",
    parentId: null,
    timestamp: new Date(1000).toISOString(),
    customType: message.customType,
    content: message.content,
    display: true,
    details,
  };
  const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
  try {
    p.handleEvent({ type: "message_start", message });
    const live = p.rows.window.find((row) => row.kind === "toolCall");
    p.loadSnapshot({ entries: [entry] });
    const history = p.rows.window.find((row) => row.kind === "toolCall");
    for (const row of [live, history]) {
      assert.ok(row?.kind === "toolCall");
      conversationRowSchema.parse(row);
      assert.equal(row.toolName, "nek.plan");
      assert.deepEqual(row.input, {
        plan: details.markdown,
        planFilePath: details.plan.path,
        revision: 2,
      });
    }
  } finally {
    p.dispose();
  }
});
