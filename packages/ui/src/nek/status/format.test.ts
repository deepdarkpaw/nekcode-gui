import { describe, expect, it } from "vitest";
import {
  contextLevel,
  contextPercent,
  formatContextPercent,
  formatUsage,
  getRunningSubagents,
  retryErrorSummary,
  retryRemainingMs,
  retryRemainingSeconds,
  subagentElapsedMs,
  subagentMetaParts,
} from "./format.js";

describe("status formatting", () => {
  it("US-2: formats usage token and cost fields through displayFormat", () => {
    const result = formatUsage({
      sessionFile: undefined,
      sessionId: "s",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1200, output: 3000, cacheRead: 4500, cacheWrite: 6000, total: 10_000 },
      cost: 1.25,
    });
    expect(result).toEqual({
      input: "1.2k",
      output: "3k",
      cacheRead: "4.5k",
      cacheWrite: "6k",
      total: "10k",
      cost: "$1.25",
    });
  });

  it("US-3: formats context percentage, tokens, and window", () => {
    expect(contextPercent(84_000, 200_000)).toBe(42);
    expect(formatContextPercent(42)).toBe("42%");
    expect(formatContextPercent(null)).toBeNull();
  });

  it("US-4: applies neutral, warning, and danger thresholds", () => {
    expect(contextLevel(null)).toBe("neutral");
    expect(contextLevel(69)).toBe("neutral");
    expect(contextLevel(70)).toBe("warning");
    expect(contextLevel(84)).toBe("warning");
    expect(contextLevel(85)).toBe("danger");
  });

  it("SA-1: computes live and terminal elapsed values", () => {
    expect(subagentElapsedMs({ status: "running", startedAt: 100 }, 1_500)).toBe(1_400);
    expect(subagentElapsedMs({ status: "completed", startedAt: 100, endedAt: 2_000 }, 9_000)).toBe(
      1_900,
    );
  });

  it("SA-1: builds metadata in model, type, usage, elapsed order", () => {
    expect(
      subagentMetaParts(
        { model: "m", type: "worker", usage: { input: 1000, output: 2000 } },
        83_000,
      ),
    ).toEqual(["m", "worker", "↑1k ↓2k", "1m 23s"]);
  });

  it("RB-1: returns running subagents sorted by startedAt", () => {
    const records = [
      { id: "late", status: "running" as const, startedAt: 20 },
      { id: "done", status: "completed" as const, startedAt: 0 },
      { id: "early", status: "running" as const, startedAt: 10 },
    ];
    expect(getRunningSubagents(records).map((record) => record.id)).toEqual(["early", "late"]);
  });

  it("RT-5 and RT-6: summarizes first-line errors and preserves full detail separately", () => {
    const long = `${"x".repeat(220)}\nsecond line`;
    expect(retryErrorSummary(long)).toHaveLength(200);
    expect(retryErrorSummary(long).endsWith("…")).toBe(true);
    expect(retryErrorSummary("first\nsecond")).toBe("first");
  });

  it("RT-2: calculates countdown milliseconds and ceiling seconds", () => {
    expect(retryRemainingMs(5_000, 1_000, 3_499)).toBe(2_501);
    expect(retryRemainingSeconds(5_000, 1_000, 3_499)).toBe(3);
    expect(retryRemainingSeconds(5_000, 1_000, 6_000)).toBe(0);
  });
});
