import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { z } from "zod";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { targetPaths } from "./paths.js";
import { createDirectoryWatch } from "./watchDirectory.js";

const FILE = ".nek-gui-config-reload.json";
const MAX_RECORDS = 64;
const MAX_SEEN_IDS = MAX_RECORDS * 2;
// Keep the SSH executor's encoded command below the per-argument limit on Linux.
const MAX_BYTES = 48 * 1024;

const recordFields = {
  id: z.string().min(1).max(128),
  at: z.number().int().nonnegative(),
  files: z.array(z.string().min(1).max(4096)).max(64),
  cwd: z.string().min(1).max(4096).optional(),
  trigger: z.enum(["write", "login", "manual"]),
};
const recordSchema = z.object(recordFields);
const journalSchema = z.object({
  ...recordFields,
  version: z.literal(1),
  previous: z
    .array(recordSchema)
    .max(MAX_RECORDS - 1)
    .optional(),
  truncated: z.literal(true).optional(),
});

type Record = z.infer<typeof recordSchema>;
export type ReloadTrigger = NonNullable<NekSessionReloadOutcome["trigger"]>;
export type ReloadChange = Pick<Record, "cwd" | "files" | "trigger">;

export function announcementPath(agentDir: string): string {
  return targetPaths(agentDir).join(agentDir, FILE);
}

function decode(text: string | null | undefined): { records: Record[]; truncated: boolean } {
  if (text == null) return { records: [], truncated: false };
  try {
    const {
      version: _version,
      previous,
      truncated,
      ...latest
    } = journalSchema.parse(JSON.parse(text));
    const records = [...(previous ?? []), latest];
    if (new Set(records.map(({ id }) => id)).size !== records.length) throw new Error();
    return { records, truncated: truncated === true };
  } catch {
    throw new Error(`Invalid reload journal (${FILE}); remove it and retry Reload`);
  }
}

/** The latest record stays at the root. A bounded tail prevents adjacent cwd-scoped writes
 * from overwriting one another before the observers see the filesystem notification. */
export async function writeReloadAnnouncement(
  executor: NekConfigHostExecutor,
  path: string,
  origin: string,
  changes: readonly ReloadChange[],
): Promise<void> {
  if (!executor.lock) throw new Error("Target does not support atomic reload announcements");
  if (changes.length === 0 || changes.length > MAX_RECORDS)
    throw new Error("Reload announcement exceeds the scope limit");
  // Allocate identities once, before retryable locking/transport. The origin prefix allows
  // skipping self without an ID cache (including after a burst larger than the journal).
  const added = changes.map((change) =>
    recordSchema.parse({ ...change, id: `${origin}:${randomUUID()}`, at: Date.now() }),
  );
  const latest = added.at(-1)!;
  await executor.lock.runLocked(
    path,
    (text) => {
      const { records, truncated } = decode(text);
      const previous = [...records, ...added.slice(0, -1)];
      const start = Math.max(0, previous.length - (MAX_RECORDS - 1));
      // Evict only earlier transactions; never report success after dropping a new scope.
      for (let index = start; index <= records.length; index += 1) {
        const next = JSON.stringify({
          version: 1,
          ...latest,
          previous: previous.slice(index),
          ...(truncated || index > 0 ? { truncated: true } : {}),
        });
        if (Buffer.byteLength(next) <= MAX_BYTES) return next;
      }
      throw new Error("Reload announcement exceeds the journal size limit");
    },
    { maxBytes: MAX_BYTES },
  );
}

/** Capture the startup cursor synchronously before this owner can launch any session. */
function initialJournal(path: string): string | null {
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) throw new Error("Reload journal is not a regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Reload journal is not a regular file");
    if (stat.size > MAX_BYTES) throw new Error("Reload journal exceeds the size limit");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count > MAX_BYTES) throw new Error("Reload journal exceeds the size limit");
    return buffer.toString("utf8", 0, count);
  } finally {
    closeSync(fd);
  }
}

async function readJournal(executor: NekConfigHostExecutor, path: string): Promise<string | null> {
  const kind = await executor.resourceEntryKind(path);
  if (kind === null) return null;
  if (kind !== "file") throw new Error("Reload journal is not a regular file");
  try {
    return await executor.readResourceFile(path, MAX_BYTES);
  } catch (error) {
    // The containing directory can be removed between the stat and the open.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Only a machine-local owner observes the journal. One read + reload flight, one dirty bit. */
export function observeReloadAnnouncements(options: {
  executor: NekConfigHostExecutor;
  agentDir: string;
  origin: string;
  debounceMs?: number;
  pollSeconds?: number;
  receive(changes: readonly ReloadChange[]): Promise<void>;
  fail(message: string): void;
}): () => void {
  const path = announcementPath(options.agentDir);
  let disposed = false;
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  let lastError: string | undefined;
  const seen = new Set<string>();
  const remember = (records: Record[]) => {
    for (const { id } of records) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > MAX_SEEN_IDS) seen.delete(seen.values().next().value!);
    }
    cursor = records.at(-1)?.id;
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (disposed || message === lastError) return;
    lastError = message;
    options.fail(message);
  };
  const schedule = () => {
    if (disposed) return;
    dirty = true;
    if (running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, options.debounceMs ?? 200);
    timer.unref();
  };
  const native = createDirectoryWatch(options.agentDir, schedule, fail, FILE);
  try {
    remember(decode(initialJournal(path)).records);
  } catch (error) {
    fail(error);
  }
  const poll = setInterval(
    () => {
      native.refresh();
      schedule();
    },
    Math.max(1, options.pollSeconds ?? 5) * 1000,
  );
  poll.unref();

  async function drain(): Promise<void> {
    running = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        try {
          const { records, truncated } = decode(await readJournal(options.executor, path));
          if (disposed) return;
          if (!native.error()) lastError = undefined;
          const index = records.findIndex(({ id }) => id === cursor);
          const unseen = records.slice(index + 1).filter(({ id }) => !seen.has(id));
          if (!unseen.length) continue;
          if (index === -1 && truncated)
            fail("Some reload announcements expired before this owner read them; retry Reload");
          remember(records);
          const incoming = unseen.filter(({ id }) => !id.startsWith(`${options.origin}:`));
          if (incoming.length) await options.receive(incoming);
        } catch (error) {
          fail(error);
        }
      }
    } finally {
      running = false;
    }
  }

  // Reconcile the interval between capturing the baseline and arming the watchers.
  schedule();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    native.dispose();
  };
}
