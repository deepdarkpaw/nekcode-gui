import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { joinFilePath } from "@/lib/path.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { readRawToolCallFileSummaries } from "./fileSummaries.js";
import { isPlainRecord, readStringField, type RawToolCallFileSummary } from "./fileSummaryTypes.js";

/** 旧 ZCode 工具调用形态（Changes 子项适配后的输入，v4 row 已无子树）。 */
type LegacyToolCall = TaskChatToolCallTreeNode["toolCall"];

export interface ChangeGroupStats {
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  unknown: number;
  added: number;
  removed: number;
  /** 同一文件被读取的次数：读取不是写操作，永远不计入 completed/added/removed。 */
  reads: number;
}

export interface ChangeFileGroup {
  key: string;
  summary?: RawToolCallFileSummary;
  calls: TaskChatToolCallTreeNode[];
  stats: ChangeGroupStats;
}

const READ_PATH_INPUT_FIELDS = ["file_path", "path", "filePath"] as const;

function emptyStats(): ChangeGroupStats {
  return {
    completed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    unknown: 0,
    added: 0,
    removed: 0,
    reads: 0,
  };
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

/** countCall 的镜像：只有这些状态还允许给文件行挂运行指示。 */
function isUnfinishedStatus(status: string | undefined): boolean {
  return status !== "failed" && status !== "stopped" && status !== "completed";
}

function isReadToolCall(call: LegacyToolCall): boolean {
  return resolveToolCallIdentity(call).family === "file-read";
}

/** 同文件 read 的路径口径必须与 edit/write 完全一致，否则同文件会裂成两个分组。 */
function resolveReadFilePath(call: LegacyToolCall): string | undefined {
  const input = call.input;
  if (!isPlainRecord(input)) return undefined;
  return readStringField(input, READ_PATH_INPUT_FIELDS);
}

/**
 * 同文件 read 只是文件明细里的一条记录，不是文件操作：摘要只提供 chip 身份，
 * 不携带 changeStat，因此绝不会被 addChanges 记成“无增删统计”的写操作。
 */
function buildReadFileSummary(path: string): RawToolCallFileSummary {
  const descriptor = resolveFileDisplayDescriptor(path);
  return {
    path,
    actionLabel: "Edited",
    operationKind: "edit",
    fileName: descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: descriptor.fileIconSrc,
  };
}

/** One linear, disposable projection; only accepted successful operation statistics are accumulated. */
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

    // 读取了同一个被修改文件的 read 与 edit/write 共用一个文件条目，
    // 用户展开文件时按真实时间顺序看到读取与编辑；它不计入写次数与增删统计。
    const readFilePath = isReadToolCall(call) ? resolveReadFilePath(call) : undefined;
    if (readFilePath) {
      const key = joinFilePath(workspacePath, readFilePath).replaceAll("\\", "/");
      let file = byPath.get(key);
      if (!file) {
        file = {
          key,
          summary: buildReadFileSummary(readFilePath),
          calls: [],
          stats: emptyStats(),
        };
        byPath.set(key, file);
      }
      file.calls.push(child);
      file.stats.reads++;
      if (isUnfinishedStatus(call.status)) {
        file.stats.running++;
        totals.running++;
      }
      continue;
    }

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
