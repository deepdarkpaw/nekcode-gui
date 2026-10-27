import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import { createMemoryNekConfigFs, type NekConfigFs } from "../src/nek-agent/config/nekConfigFs.js";
import {
  JsonNekSessionIndexStorage,
  MemoryNekSessionIndexStorage,
  NekSessionIndexCorruptError,
  NekSessionIndexSyncer,
  parseNekSessionIndex,
} from "../src/nek-agent/index.js";
import type { NekSessionIndexDocument, NekSessionIndexEntry } from "../src/nek-agent/index.js";

/**
 * 会话索引的硬约束：
 * - GUI 只保存自己的元数据（置顶、归档、未读、分组、最后打开时间），标题与时间戳以 `list_sessions` 为准；
 * - JSON 文件走 `.tmp` + rename 原子写，条数有上限；
 * - 对账时 nek 已删除的会话标为失效、新会话补默认元数据、已有会话保留本地元数据；
 * - 文件损坏必须报错（`NekSessionIndexCorruptError`），不能静默清空。
 */

function summary(path: string, overrides: Partial<NekSessionSummary> = {}): NekSessionSummary {
  return {
    path,
    id: path.replaceAll("/", "-"),
    cwd: "/workspace/app",
    name: path,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 4,
    firstMessage: "hello",
    locked: false,
    ...overrides,
  };
}

function entry(path: string, overrides: Partial<NekSessionIndexEntry> = {}): NekSessionIndexEntry {
  return { sessionPath: path, pinned: false, archived: false, unread: false, ...overrides };
}

function document(entries: NekSessionIndexEntry[]): NekSessionIndexDocument {
  return { version: 1, entries };
}

/** 记录写入顺序的内存 fs：用来确认先写 `.tmp` 再 rename。 */
function recordingFs() {
  const fs = createMemoryNekConfigFs();
  const ops: string[] = [];
  const recording: NekConfigFs = {
    ...fs,
    writeFile: async (path, content) => {
      ops.push(`write:${path}`);
      await fs.writeFile(path, content);
    },
    rename: async (from, to) => {
      ops.push(`rename:${from}->${to}`);
      await fs.rename(from, to);
    },
  };
  return { fs: recording, files: fs.files, ops };
}

test("memory storage round-trips entries and copies on read", async () => {
  const storage = new MemoryNekSessionIndexStorage(document([entry("/a.jsonl", { pinned: true })]));
  const loaded = await storage.load();
  assert.deepEqual(loaded.entries, [entry("/a.jsonl", { pinned: true })]);
  loaded.entries[0]!.pinned = false;
  const again = await storage.load();
  assert.equal(again.entries[0]!.pinned, true, "load 必须返回副本，调用方改不动存储");

  await storage.save(document([entry("/b.jsonl", { unread: true })]));
  assert.deepEqual((await storage.load()).entries, [entry("/b.jsonl", { unread: true })]);
});

test("memory storage drops entries beyond the configured cap", async () => {
  const storage = new MemoryNekSessionIndexStorage(
    document([entry("/1.jsonl"), entry("/2.jsonl"), entry("/3.jsonl")]),
    2,
  );
  assert.deepEqual(
    (await storage.load()).entries.map((item) => item.sessionPath),
    ["/1.jsonl", "/2.jsonl"],
  );
});

test("json storage writes through .tmp and renames onto the target", async () => {
  const { fs, files, ops } = recordingFs();
  const path = join("/agent", "session-index.json");
  const storage = new JsonNekSessionIndexStorage(path, { fs });
  await storage.save(document([entry("/a.jsonl", { group: "today" })]));

  assert.deepEqual(ops, [`write:${path}.tmp`, `rename:${path}.tmp->${path}`]);
  assert.equal(files.has(`${path}.tmp`), false, "临时文件不能在成功后被留下");
  assert.deepEqual((await storage.load()).entries, [entry("/a.jsonl", { group: "today" })]);
});

test("json storage round-trips on disk and treats a missing file as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nek-index-"));
  try {
    const path = join(dir, "session-index.json");
    const storage = new JsonNekSessionIndexStorage(path);
    assert.deepEqual(await storage.load(), document([]), "文件不存在不是损坏");

    await storage.save(
      document([entry("/a.jsonl", { archived: true, lastOpenedAt: "2026-02-01" })]),
    );
    assert.deepEqual((await storage.load()).entries, [
      entry("/a.jsonl", { archived: true, lastOpenedAt: "2026-02-01" }),
    ]);
    assert.deepEqual(await readdir(dir), ["session-index.json"], "原子写不留临时文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json storage reports corrupt files instead of clearing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nek-index-"));
  try {
    const path = join(dir, "session-index.json");
    const storage = new JsonNekSessionIndexStorage(path);

    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(storage.load(), (error: unknown) => {
      assert.ok(error instanceof NekSessionIndexCorruptError);
      assert.match(error.message, /invalid JSON/u);
      assert.equal(error.path, path);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), "{ not json", "损坏文件必须原样保留");

    await writeFile(path, JSON.stringify({ version: 2, entries: [] }), "utf8");
    await assert.rejects(storage.load(), /unsupported version 2/u);

    await writeFile(path, JSON.stringify({ version: 1, entries: [{ sessionPath: 3 }] }), "utf8");
    await assert.rejects(storage.load(), /entries\[0\] is not a session entry/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parse rejects a document that is not an index", () => {
  assert.throws(() => parseNekSessionIndex("[]", "/x.json"), NekSessionIndexCorruptError);
  assert.throws(() => parseNekSessionIndex("{}", "/x.json"), /unsupported version undefined/u);
  assert.deepEqual(parseNekSessionIndex('{"version":1,"entries":[]}', "/x.json"), document([]));
});

test("sync invalidates missing sessions, adds new ones and keeps local metadata", async () => {
  const storage = new MemoryNekSessionIndexStorage(
    document([
      entry("/a.jsonl", { pinned: true, group: "today", lastOpenedAt: "2026-01-03T00:00:00.000Z" }),
      entry("/b.jsonl", { unread: true }),
    ]),
  );
  const syncer = new NekSessionIndexSyncer({
    storage,
    listSessions: async () => [summary("/a.jsonl"), summary("/c.jsonl")],
  });

  const result = await syncer.sync({ all: true });
  assert.deepEqual(result.added, ["/c.jsonl"]);
  assert.deepEqual(result.invalidated, ["/b.jsonl"]);
  assert.deepEqual(result.restored, []);

  const stored = new Map((await storage.load()).entries.map((item) => [item.sessionPath, item]));
  assert.deepEqual(stored.get("/a.jsonl"), {
    sessionPath: "/a.jsonl",
    pinned: true,
    archived: false,
    unread: false,
    group: "today",
    lastOpenedAt: "2026-01-03T00:00:00.000Z",
    invalid: false,
  });
  assert.equal(stored.get("/b.jsonl")?.invalid, true, "nek 已删除的会话只标失效");
  assert.equal(stored.get("/b.jsonl")?.unread, true, "失效条目的本地元数据仍然保留");
  assert.deepEqual(stored.get("/c.jsonl"), entry("/c.jsonl"));
  assert.equal(
    result.items.find((item) => item.metadata.sessionPath === "/c.jsonl")?.summary?.id,
    "-c.jsonl",
  );
});

test("sync restores a session that reappears and never invalidates on cwd-only syncs", async () => {
  const storage = new MemoryNekSessionIndexStorage(
    document([entry("/a.jsonl", { invalid: true }), entry("/other.jsonl")]),
  );
  const syncer = new NekSessionIndexSyncer({
    storage,
    listSessions: async () => [summary("/a.jsonl")],
  });

  const result = await syncer.sync({ cwd: "/workspace/app" });
  assert.deepEqual(result.restored, ["/a.jsonl"]);
  assert.deepEqual(result.invalidated, [], "按 cwd 对账不能把别的工作区标成失效");
  assert.equal(
    (await storage.load()).entries.find((item) => item.sessionPath === "/a.jsonl")?.invalid,
    false,
  );
});

test("turn completion marks unread only when the session is not in the foreground", async () => {
  const storage = new MemoryNekSessionIndexStorage(
    document([entry("/a.jsonl"), entry("/b.jsonl")]),
  );
  const syncer = new NekSessionIndexSyncer({ storage, listSessions: async () => [] });

  syncer.setForeground("/a.jsonl");
  await syncer.markTurnCompleted("/b.jsonl");
  await syncer.markTurnCompleted("/a.jsonl");
  const stored = new Map((await storage.load()).entries.map((item) => [item.sessionPath, item]));
  assert.equal(stored.get("/b.jsonl")?.unread, true);
  assert.equal(stored.get("/a.jsonl")?.unread, false, "前台会话的回合完成不置未读");

  await syncer.markOpened("/b.jsonl");
  const reopened = (await storage.load()).entries.find((item) => item.sessionPath === "/b.jsonl");
  assert.equal(reopened?.unread, false);
  assert.ok(reopened?.lastOpenedAt);
  assert.equal(syncer.setForeground("/a.jsonl"), undefined);
});

test("metadata updates are kept and bounded by the entry cap", async () => {
  const storage = new MemoryNekSessionIndexStorage(
    document([entry("/a.jsonl"), entry("/b.jsonl")]),
  );
  let clock = new Date("2026-03-01T00:00:00.000Z");
  const syncer = new NekSessionIndexSyncer({
    storage,
    listSessions: async () => [],
    maxEntries: 2,
    now: () => clock,
  });

  await syncer.setArchived("/a.jsonl", true);
  await syncer.setGroup("/a.jsonl", "later");
  await syncer.setPinned("/b.jsonl", true);
  clock = new Date("2026-03-02T00:00:00.000Z");
  await syncer.markOpened("/b.jsonl");

  // 新增第三条时按"置顶 → 有效 → 最近打开"保留，被挤掉的是最近没打开的 /a.jsonl。
  await syncer.update("/c.jsonl", { group: "new", lastOpenedAt: "2026-03-03T00:00:00.000Z" });
  const entries = (await storage.load()).entries;
  assert.deepEqual(
    entries.map((item) => item.sessionPath),
    ["/b.jsonl", "/c.jsonl"],
  );
  assert.equal(entries[0]!.pinned, true);
});

test("concurrent metadata updates do not lose writes", async () => {
  const storage = new MemoryNekSessionIndexStorage(document([]));
  const syncer = new NekSessionIndexSyncer({ storage, listSessions: async () => [] });
  await Promise.all([
    syncer.setPinned("/a.jsonl", true),
    syncer.setArchived("/a.jsonl", true),
    syncer.setGroup("/a.jsonl", "g"),
  ]);
  const stored = (await storage.load()).entries.find((item) => item.sessionPath === "/a.jsonl");
  assert.equal(stored?.pinned, true);
  assert.equal(stored?.archived, true);
  assert.equal(stored?.group, "g");
});
