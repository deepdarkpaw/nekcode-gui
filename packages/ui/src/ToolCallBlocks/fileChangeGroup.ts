import { joinFilePath } from "@/lib/path.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { readRawToolCallFileSummaries } from "./fileSummaries.js";
import type { RawToolCallFileSummary } from "./fileSummaryTypes.js";

export interface ChangeGroupStats {
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  unknown: number;
  added: number;
  removed: number;
}

export interface ChangeFileGroup {
  key: string;
  summary?: RawToolCallFileSummary;
  calls: TaskChatToolCallTreeNode[];
  stats: ChangeGroupStats;
}

function emptyStats(): ChangeGroupStats {
  return { completed: 0, failed: 0, cancelled: 0, running: 0, unknown: 0, added: 0, removed: 0 };
}

function countCall(stats: ChangeGroupStats, status: string | undefined): void {
  if (status === "failed") stats.failed++;
  else if (status === "stopped") stats.cancelled++;
  else if (status !== "completed") stats.running++;
  else stats.completed++;
}

function addChanges(stats: ChangeGroupStats, summary?: RawToolCallFileSummary): void {
  if (!summary?.changeStat) stats.unknown++;
  else {
    stats.added += summary.changeStat.added;
    stats.removed += summary.changeStat.removed;
  }
}

/**
 * 只接受写操作的线性、一次性投影：读取不是写操作，永远不进入更改文件明细，
 * 也不参与成功次数或增删统计（同文件读取由 readGroup 单独展示）。
 */
export function buildFileChangeGroup(
  calls: readonly TaskChatToolCallTreeNode[],
  workspacePath: string,
) {
  const byPath = new Map<string, ChangeFileGroup>();
  const totals = emptyStats();
  const seen = new Set<string>();
  for (const child of calls) {
    const call = child.toolCall;
    if (seen.has(call.toolId)) continue;
    seen.add(call.toolId);
    const summaries = readRawToolCallFileSummaries(call.raw, call, "summary");
    const files: Array<RawToolCallFileSummary | undefined> = summaries.length
      ? summaries
      : [undefined];
    for (const summary of files) {
      const key = summary
        ? joinFilePath(workspacePath, summary.path).replaceAll("\\", "/")
        : `pending:${call.toolId}`;
      let file = byPath.get(key);
      if (!file) {
        file = { key, summary, calls: [], stats: emptyStats() };
        byPath.set(key, file);
      }
      file.summary = summary;
      file.calls.push(child);
      countCall(file.stats, call.status);
      if (call.status === "completed") {
        addChanges(file.stats, summary);
        addChanges(totals, summary);
      }
    }
    // A multi-file call is one successful operation, not one operation per file.
    countCall(totals, call.status);
  }
  return { files: [...byPath.values()], totals };
}
