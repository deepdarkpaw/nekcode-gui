import assert from "node:assert/strict";
import test from "node:test";
import type { NekRpcEvent, NekState, NekStatusSnapshot } from "@zcode/shared/nek-protocol";
import {
  boundNekStatusSnapshot,
  boundNekStatusState,
  projectNekStatusEvent,
} from "../src/nek-agent/adapter/nekAgentStatusChannel.js";

function state(): NekState {
  return {
    mode: "agent",
    todos: Array.from({ length: 120 }, (_, index) => ({
      id: `todo-${index}`,
      content: `Todo ${index}`,
      status: "pending" as const,
    })),
    plans: Array.from({ length: 60 }, (_, index) => ({
      path: `/plan/${index}`,
      name: `Plan ${index}`,
      overview: "overview",
      revision: 1,
      status: "ready" as const,
      todos: [],
    })),
    subagents: Array.from({ length: 70 }, (_, index) => ({
      id: `agent-${index}`,
      description: "worker",
      type: "worker",
      background: false,
      status: "running" as const,
      startedAt: 0,
    })),
  };
}

test("status projection maps queue events and enforces frame bounds", () => {
  const event: NekRpcEvent = {
    type: "queue_update",
    steering: Array.from({ length: 120 }, (_, index) => `steer-${index}`),
    followUp: Array.from({ length: 120 }, (_, index) => `follow-${index}`),
  };
  const projected = projectNekStatusEvent(event);
  assert.equal(projected?.type, "queue_update");
  if (projected?.type !== "queue_update") throw new Error("queue event was not projected");
  assert.equal(projected.steering.length, 100);
  assert.equal(projected.followUp.length, 100);
});

test("status projection keeps state events and ignores unrelated RPC records", () => {
  const stateEvent: NekRpcEvent = { type: "extension_event", name: "nek.state", payload: state() };
  const projected = projectNekStatusEvent(stateEvent);
  assert.equal(projected?.type, "extension_event");
  if (projected?.type !== "extension_event") throw new Error("state event was not projected");
  assert.equal((projected.payload as NekState).todos.length, 100);
  assert.equal(projectNekStatusEvent({ type: "extension_ui_cancel", id: "request" }), null);
});

test("status snapshot bounding is idempotent for duplicate snapshots", () => {
  const snapshot: NekStatusSnapshot = {
    sessionKey: "session",
    running: true,
    state: state(),
    stats: {
      sessionFile: undefined,
      sessionId: "session",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
  };
  const first = boundNekStatusSnapshot(snapshot);
  const second = boundNekStatusSnapshot(first);
  assert.deepEqual(second, first);
  assert.equal(boundNekStatusState(snapshot.state).subagents.length, 50);
});
