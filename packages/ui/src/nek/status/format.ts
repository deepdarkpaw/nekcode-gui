import { formatCost, formatDuration, formatTokens } from "@/lib/displayFormat.js";
import type { NekSessionStats, NekSubagentRecord } from "@zcode/shared/nek-protocol";

export { formatCost, formatDuration, formatTokens };

export const CONTEXT_WARNING_PERCENT = 70;
export const CONTEXT_DANGER_PERCENT = 85;

export type ContextLevel = "neutral" | "warning" | "danger";

export function contextLevel(percent: number | null): ContextLevel {
  if (percent === null || !Number.isFinite(percent)) return "neutral";
  if (percent >= CONTEXT_DANGER_PERCENT) return "danger";
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
  return "neutral";
}

export function contextPercent(tokens: number | null, contextWindow: number): number | null {
  if (tokens === null || !Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.round((tokens / contextWindow) * 100);
}

export function formatContextPercent(percent: number | null): string | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return `${Math.round(percent)}%`;
}

export interface UsageDisplay {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  total: string;
  cost: string;
}

export function formatUsage(stats: NekSessionStats): UsageDisplay {
  return {
    input: formatTokens(stats.tokens.input),
    output: formatTokens(stats.tokens.output),
    cacheRead: formatTokens(stats.tokens.cacheRead),
    cacheWrite: formatTokens(stats.tokens.cacheWrite),
    total: formatTokens(stats.tokens.total),
    cost: formatCost(stats.cost),
  };
}

export function subagentElapsedMs(
  record: Pick<NekSubagentRecord, "status" | "startedAt" | "endedAt">,
  now: number,
): number {
  const end = record.status === "running" ? now : (record.endedAt ?? now);
  return Math.max(0, end - record.startedAt);
}

export function subagentMetaParts(
  record: Pick<NekSubagentRecord, "model" | "type" | "usage">,
  elapsedMs: number,
): string[] {
  const parts: string[] = [];
  if (record.model) parts.push(record.model);
  parts.push(record.type);
  if (record.usage) {
    parts.push(`↑${formatTokens(record.usage.input)} ↓${formatTokens(record.usage.output)}`);
  }
  parts.push(formatDuration(elapsedMs));
  return parts;
}

export function retryErrorSummary(error: string): string {
  const firstLine = error.split(/\r?\n/u, 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
}

export function retryRemainingMs(
  delayMs: number,
  startedAt: number,
  now: number,
): number {
  return Math.max(0, delayMs - Math.max(0, now - startedAt));
}

export function retryRemainingSeconds(
  delayMs: number,
  startedAt: number,
  now: number,
): number {
  return Math.ceil(retryRemainingMs(delayMs, startedAt, now) / 1000);
}

export function getRunningSubagents<T extends Pick<NekSubagentRecord, "status" | "startedAt">>(
  records: readonly T[],
): T[] {
  return records
    .filter((record) => record.status === "running")
    .toSorted((left, right) => left.startedAt - right.startedAt);
}
EOF