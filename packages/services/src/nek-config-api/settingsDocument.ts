/**
 * settings.json 的读写：与 nek 共用同一把锁，只合并改动过的键。
 *
 * 为什么必须用锁：nek 与 GUI 是两个进程，谁后写谁赢的整文件覆盖会把对方刚写的字段抹掉
 * （典型场景：GUI 里改默认模型的同时，nek 在另一个会话里写了 `lastChangelogVersion`）。
 * 锁的参数与 nek 完全一致（`proper-lockfile` 的 `lockSync(path, { realpath: false })`），
 * 所以两边能互斥。
 */
import type { NekSettingsView } from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { applySettingsPatch, parseJsonMapping, readTextDocument } from "./documents.js";
import { conflict, ioError } from "./errors.js";
import { ABSENT_REVISION, encodeRevision, sameRevision } from "./revision.js";
import { toSettingsView } from "./settingsDefaults.js";

export interface NekSettingsDocument {
  path: string;
  revision: string;
  values: NekSettingsView;
  /** 文件里的原始对象（合并 `effective` 用）。 */
  raw: Record<string, unknown>;
}

/** 读 settings.json；不存在时 `values` 为空对象、revision 为 `absent`。 */
export async function readSettingsDocument(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<NekSettingsDocument> {
  const document = await readTextDocument(executor, path);
  if (document.content === null || document.content.trim() === "") {
    return { path, revision: document.revision, values: {}, raw: {} };
  }
  const raw = parseJsonMapping(path, document.content);
  return { path, revision: document.revision, values: toSettingsView(raw), raw };
}

export interface PatchSettingsArgs {
  executor: NekConfigHostExecutor;
  path: string;
  /** 已展开 `extra` 的补丁（`null` 表示删除该键）。 */
  patch: Record<string, unknown>;
  /** 读取时拿到的 revision。 */
  expectedRevision: string;
}

/**
 * 在锁内读改写：锁内比对 revision → 合并补丁 → 写回。返回新的 revision。
 *
 * revision 在锁内比对是刻意的：锁外的"读-比-写"会被另一个进程的写入插进来。
 */
export async function patchSettingsDocument(
  args: PatchSettingsArgs,
): Promise<{ path: string; revision: string }> {
  const { executor, path, patch, expectedRevision } = args;
  const lock = executor.lock;
  if (!lock) {
    throw ioError(`cannot write ${path}: the target executor provides no settings lock`);
  }
  let next: string | undefined;
  lock.runLocked(path, (current) => {
    const currentRevision =
      current === undefined
        ? ABSENT_REVISION
        : encodeRevision({ mtimeMs: 0, size: Buffer.byteLength(current, "utf8") }, current);
    if (!sameRevision(currentRevision, expectedRevision)) throw conflict(path);
    const parsed =
      current === undefined || current.trim() === "" ? {} : parseJsonMapping(path, current);
    const merged = applySettingsPatch(parsed, patch);
    next = `${JSON.stringify(merged, null, 2)}\n`;
    return next;
  });
  if (next === undefined) {
    // 回调没有产出内容：说明没有走到写入分支，属于实现错误，不能静默成功。
    throw ioError(`failed to write ${path}: the lock callback produced no content`);
  }
  const revision = await readTextDocument(executor, path).then((document) => document.revision);
  return { path, revision };
}
