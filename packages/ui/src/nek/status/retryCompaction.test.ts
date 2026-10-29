import { describe, expect, it } from "vitest";
import { createNekSessionStatus, reduceNekStatusEvent } from "./reducer.js";
import { advanceNekStatus } from "./retryCompactionReducer.js";

describe("retry and compaction reducers", () => {
  it("RT-1: enters waiting with an injected start time", () => {
    const reduced = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "s",
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 4,
        delayMs: 3000,
        errorMessage: "network",
      },
      1000,
    );
    expect(reduced.state.retry).toEqual({
      phase: "waiting",
      kind: "agent",
      attempt: 2,
      max: 4,
      delayMs: 3000,
      startedAt: 1000,
      errorMessage: "network",
    });
  });

  it("RT-2: transitions waiting to retrying when the countdown reaches zero", () => {
    const waiting = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "s",
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1000,
        errorMessage: "summary failed",
      },
      1000,
    ).state;
    expect(advanceNekStatus(waiting, 1999)).toBe(waiting);
    expect(advanceNekStatus(waiting, 2000).retry?.phase).toBe("retrying");
  });

  it("RT-2: attempt-start immediately enters retrying", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 5000,
        errorMessage: "bad",
      },
      1,
    ).state;
    const reduced = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "summarization_retry_attempt_start",
        source: "compaction",
      },
      2,
    );
    expect(reduced.state.retry?.phase).toBe("retrying");
  });

  it("RT-3 and RT-4: clears successful retry and retains a final failure", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: "first",
      },
      1,
    ).state;
    const failed = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "final",
      },
      2,
    ).state;
    expect(failed.retry).toEqual({ phase: "failed", kind: "agent", max: 2, finalError: "final" });
    const succeeded = reduceNekStatusEvent(
      failed,
      "s",
      {
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      },
      3,
    ).state;
    expect(succeeded.retry).toBeNull();
  });

  it("RT-9: a new retry start replaces a failed banner", () => {
    let current = createNekSessionStatus(0);
    current = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "failed",
      },
      1,
    ).state;
    const next = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "again",
      },
      2,
    ).state;
    expect(next.retry?.phase).toBe("waiting");
  });

  it("CP-1 and CP-2: tracks compaction reason and elapsed source", () => {
    const reduced = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "s",
      {
        type: "compaction_start",
        reason: "threshold",
      },
      1000,
    );
    expect(reduced.state.compaction).toEqual({
      phase: "running",
      reason: "threshold",
      startedAt: 1000,
    });
  });

  it("CP-3: abort emits a notice, retry keeps running, and success marks stats stale", () => {
    let current = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "s",
      {
        type: "compaction_start",
        reason: "manual",
      },
      1,
    ).state;
    const retrying = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: true,
      },
      2,
    );
    expect(retrying.state.compaction?.phase).toBe("running");
    const aborted = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
      },
      3,
    );
    expect(aborted.state.compaction).toBeNull();
    expect(aborted.output.notice?.id).toBe("nek.status.compaction.aborted");
    current = reduceNekStatusEvent(
      createNekSessionStatus(0),
      "s",
      {
        type: "compaction_start",
        reason: "manual",
      },
      4,
    ).state;
    const success = reduceNekStatusEvent(
      current,
      "s",
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
      },
      5,
    );
    expect(success.state.compaction).toBeNull();
    expect(success.state.statsStale).toBe(true);
  });
});
