/**
 * 配置文件的 revision 令牌：`mtime + size + sha256`。
 *
 * 为什么三者都要：mtime 精度在不同文件系统上从 1 s 到 1 ms 不等，size 相同的内容替换会被漏掉，
 * 所以内容哈希兜底。令牌对调用方不透明（契约里只是 `string`），文件不存在时固定为 `absent`。
 */
import { createHash } from "node:crypto";

/** 文件不存在时的 revision（契约要求）。 */
export const ABSENT_REVISION = "absent";

/** 执行器 `stat` 的结果；目录也返回（`listDir` 之外还要判断条目类型）。 */
export interface NekHostStat {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
}

/** 解析后的 revision；`null` 表示 `absent` 或形状不认识（视为"与任何令牌都不同"）。 */
export interface NekRevisionParts {
  mtimeMs: number;
  size: number;
  hash: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 由 stat 元信息 + 内容哈希组成令牌。 */
export function encodeRevision(stat: { mtimeMs: number; size: number }, content: string): string {
  return `${Math.floor(stat.mtimeMs)}:${stat.size}:${hashContent(content)}`;
}

export function parseRevision(revision: string): NekRevisionParts | null {
  if (revision === ABSENT_REVISION) return null;
  const match = /^(\d+):(\d+):([0-9a-f]{8,})$/u.exec(revision);
  if (!match) return null;
  return { mtimeMs: Number(match[1]), size: Number(match[2]), hash: match[3] ?? "" };
}

/**
 * 两个令牌是否指同一份内容。
 *
 * 只比内容哈希：把文件原样写回（内容不变、mtime 变了）不应被当成外部修改，
 * 否则"保存未改动的表单"会误报冲突。
 */
export function sameRevision(left: string, right: string): boolean {
  if (left === right) return true;
  const a = parseRevision(left);
  const b = parseRevision(right);
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size;
}
