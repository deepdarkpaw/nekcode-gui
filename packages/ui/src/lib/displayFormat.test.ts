import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatTokens,
  formatDuration,
  formatCost,
} from "./displayFormat.js";

const formatMessage = ({ id }: { id: string }, values?: Record<string, string | number>) =>
  values ? `${id}:${JSON.stringify(values)}` : id;

describe("formatDateTime", () => {
  it("formats local time as YYYY-MM-DD HH:mm with zero padding", () => {
    const date = new Date(2026, 0, 5, 7, 3, 59);
    expect(formatDate(date)).toBe("2026-01-05");
    expect(formatDateTime(date)).toBe("2026-01-05 07:03");
    expect(formatDateTime(date.getTime())).toBe("2026-01-05 07:03");
  });

  it("returns an empty string for invalid dates", () => {
    expect(formatDateTime(Number.NaN)).toBe("");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 9, 25, 12, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("uses relative labels within 24 hours and keeps the absolute time as title", () => {
    expect(formatRelativeTime(ago(30_000), formatMessage, now)).toEqual({
      label: "ui.relativeTime.justNow",
      title: "2026-10-25 11:59",
    });
    expect(formatRelativeTime(ago(5 * 60_000), formatMessage, now).label).toBe(
      'ui.relativeTime.minutesAgo:{"count":5}',
    );
    expect(formatRelativeTime(ago(3 * 3_600_000 + 1), formatMessage, now).label).toBe(
      'ui.relativeTime.hoursAgo:{"count":3}',
    );
  });

  it("falls back to the absolute time beyond 24 hours or in the future", () => {
    const old = ago(24 * 3_600_000);
    expect(formatRelativeTime(old, formatMessage, now).label).toBe("2026-10-24 12:00");
    const future = new Date(now.getTime() + 60_000);
    expect(formatRelativeTime(future, formatMessage, now).label).toBe("2026-10-25 12:01");
  });
});

describe("formatBytes", () => {
  it("uses B / KB / MB / GB with one decimal at most", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2.25 * 1024 ** 3)).toBe("2.3 GB");
    expect(formatBytes(4096 * 1024 ** 3)).toBe("4096 GB");
  });

  it("carries rounded values to the next unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
  });

  it("rejects invalid sizes", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats the ST duration thresholds", () => {
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(3_662_000)).toBe("1h 01m");
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatCost", () => {
  it("formats the ST cost thresholds", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("formatTokens", () => {
  it("uses k with 1k = 1000", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_949)).toBe("999.9k");
  });

  it("carries rounding overflow to the next unit", () => {
    expect(formatTokens(999.6)).toBe("1k");
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("keeps the sign for negative deltas", () => {
    expect(formatTokens(-1500)).toBe("-1.5k");
  });
});
