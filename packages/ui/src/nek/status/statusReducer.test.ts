import { describe, expect, it, beforeEach } from "vitest";
import type { NekState, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { createNekSessionStatus, reduceNekStatusEvent } from "./reducer.js";
import { useNekStatusStore } from "./store.js";

function subagent(id: string, status: NekSubagentRecord["status"] = "running"): NekSubagentRecord {
  return {
    id,
    description: id,
    type: "worker",
    background: true,
    status,
    startedAt: 0,
    ...(status !== "running" ? { endedAt: 1 } : {}),
  };
}

function state(subagents: NekSubagentRecord[]): NekState {
  return { mode: "agent", todos: [], plans: [], subagents };
}

describe("ST", () => {
  beforeEach(() => useNekStatusStore.getState().reset());

  it("ST-1: replaces state fields and aborts a locally running missing subagent", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.subagent", payload: subagent("old") },
      1,
    ).state;
    const reduced = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.state", payload: { ...state([]), mode: "plan", activePlanPath: "plan.md" } },
      2,
    );
    expect(reduced.state.mode).toBe("plan");
    expect(reduced.state.activePlanPath).toBe("plan.md");
    expect(reduced.state.subagents.byId.old?.status).toBe("aborted");
    expect(reduced.output.subagentFinished?.[0]?.status).toBe("aborted");
  });

  it("ST-2: never rolls a terminal subagent back to running", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.subagent", payload: subagent("a") },
      1,
    ).state;
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.subagent", payload: subagent("a", "completed") },
      2,
    ).state;
    const reduced = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.subagent", payload: subagent("a") },
      3,
    );
    expect(reduced.state).toBe(current);
  });

  it("ST-3: evicts the earliest ended records but never running records", () => {
    const ended = Array.from({ length: 2 }, (_, index) => subagent(`ended-${index}`, "completed"));
    const running = Array.from({ length: 50 }, (_, index) => subagent(`running-${index}`));
    const reduced = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "session",
      {
        type: "nek.state",
        payload: state([...ended, ...running]),
      },
      1,
    );
    expect(reduced.state.subagents.order).toHaveLength(50);
    expect(reduced.state.subagents.byId["ended-0"]).toBeUndefined();
    expect(reduced.state.subagents.byId["running-0"]).toBeDefined();
  });

  it("ST-3: keeps all running records when no ended record can be evicted", () => {
    const running = Array.from({ length: 51 }, (_, index) => subagent(`running-${index}`));
    const reduced = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "session",
      {
        type: "nek.state",
        payload: state(running),
      },
      1,
    );
    expect(reduced.state.subagents.order).toHaveLength(51);
  });

  it("ST-4: replaces both queues as one snapshot", () => {
    const reduced = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "session",
      {
        type: "queue_update",
        steering: ["now"],
        followUp: ["later"],
      },
      1,
    );
    expect(reduced.state.queue).toEqual({ steering: ["now"], followUp: ["later"] });
  });

  it("ST-5: retains the current session while evicting the oldest non-current session", () => {
    useNekStatusStore.getState().setCurrentSession("session-0", 0);
    for (let index = 1; index <= 20; index += 1) {
      useNekStatusStore.getState().consumeEvent(`session-${index}`, { type: "agent_start" }, index);
    }
    const sessions = useNekStatusStore.getState().sessions;
    expect(Object.keys(sessions)).toHaveLength(20);
    expect(sessions["session-0"]).toBeDefined();
    expect(sessions["session-1"]).toBeUndefined();
  });

  it("ST-6: does not change state merely because no ticker condition is active", () => {
    const current = createNekSessionStatus(0);
    expect(current.retry).toBeNull();
    expect(current.compaction).toBeNull();
    expect(current.subagents.order).toHaveLength(0);
  });

  it("ST-7: marks stats stale and throttles refresh requests while preserving the pending request", () => {
    const first = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "session",
      { type: "agent_settled" },
      1000,
    );
    const second = reduceNekStatusEvent(
      first.state,
      "session",
      { type: "message_end", message: {} },
      1500,
    );
    expect(first.output.needsStatsRefresh).toBe(true);
    expect(second.output.needsStatsRefresh).toBe(false);
    expect(second.state.statsStale).toBe(true);
    expect(second.state.statsRefreshPending).toBe(true);
    expect(useNekStatusStore.getState().flushStatsRefresh("missing", 3000)).toBe(false);
  });

  it("ST-8: aborts running work and clears retry, compaction, and queue on process exit", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "nek.subagent", payload: subagent("a") },
      1,
    ).state;
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "bad" },
      2,
    ).state;
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "compaction_start", reason: "manual" },
      3,
    ).state;
    current = reduceNekStatusEvent(
      current,
      "session",
      { type: "queue_update", steering: ["a"], followUp: ["b"] },
      4,
    ).state;
    const reduced = reduceNekStatusEvent(current, "session", { type: "process_exit" }, 5);
    expect(reduced.state.subagents.byId.a?.status).toBe("aborted");
    expect(reduced.state.retry).toBeNull();
    expect(reduced.state.compaction).toBeNull();
    expect(reduced.state.queue).toEqual({ steering: [], followUp: [] });
  });
});
