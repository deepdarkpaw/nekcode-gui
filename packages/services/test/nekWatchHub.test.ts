import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import test from "node:test";
import {
  NekWatchHub,
  type NekWatchChange,
  type NekWatchTarget,
} from "../src/nek-config-api/watch.js";
import { createMemoryNekConfigHostExecutor } from "../src/nek-config-api/hostExecutor.js";

const GLOBAL = join("/isolated", "agent");
const PROJECT_A = join("/isolated", "a", ".nek");
const PROJECT_B = join("/isolated", "b", ".nek");
const files = [GLOBAL, PROJECT_A, PROJECT_B].map((directory) => join(directory, "settings.json"));
const flush = async () => {
  await setImmediate();
};

function setup() {
  const executor = createMemoryNekConfigHostExecutor({
    files: Object.fromEntries(files.map((file) => [file, "{}"])),
  });
  const hub = new NekWatchHub({ pollSeconds: 1 });
  const target = (project?: string, key = "local"): NekWatchTarget => ({
    key,
    executor,
    local: false,
    dirs: [
      { path: GLOBAL, scope: "global" },
      ...(project ? [{ path: project, scope: "project" as const }] : []),
    ],
  });
  return { hub, executor, target };
}

test("MW-H1: directory union, filtered delivery and exact reference-counted release", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { hub, executor, target } = setup();
  t.after(() => hub.dispose());
  const global: NekWatchChange[] = [];
  const a: NekWatchChange[] = [];
  const b: NekWatchChange[] = [];
  const stopGlobal = hub.subscribe(target(), (change) => global.push(change));
  const notifyA = (change: NekWatchChange) => a.push(change);
  const stopA = hub.subscribe(target(PROJECT_A), notifyA);
  const stopA2 = hub.subscribe(target(PROJECT_A), notifyA);
  const stopB = hub.subscribe(target(PROJECT_B), (change) => b.push(change));
  await flush();
  global.length = a.length = b.length = 0;
  for (const file of files) executor.setFile(file, '{"defaultModel":"changed"}');
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(
    global.map((entry) => entry.file),
    [files[0]],
  );
  assert.deepEqual(
    a.map((entry) => entry.file).sort(),
    [files[0], files[0], files[1], files[1]].sort(),
  );
  assert.deepEqual(b.map((entry) => entry.file).sort(), [files[0], files[2]].sort());
  stopA();
  stopA();
  a.length = b.length = 0;
  executor.setFile(files[1]!, '{"defaultModel":"a2"}');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(a.length, 1, "same callback's second lease survives the first disposal");
  stopA2();
  a.length = 0;
  executor.setFile(files[1]!, '{"defaultModel":"a3"}');
  executor.setFile(files[2]!, '{"defaultModel":"b3"}');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(a.length, 0);
  assert.equal(b.length, 1, "B remains observed after A is released");
  stopGlobal();
  stopB();
});

test("MW-H2: local and remote target keys never share delivery or release", async () => {
  const { hub, target } = setup();
  const local: NekWatchChange[] = [];
  const remote: NekWatchChange[] = [];
  const stopLocal = hub.subscribe(target(PROJECT_A, "local"), (change) => local.push(change));
  const stopRemote = hub.subscribe(target(PROJECT_A, "remote:ssh-1"), (change) =>
    remote.push(change),
  );
  await flush();
  local.length = remote.length = 0;
  hub.publish("remote:ssh-1", [{ file: files[1]!, revision: "remote-write" }]);
  assert.equal(local.length, 0);
  assert.equal(remote[0]?.revision, "remote-write");
  stopLocal();
  hub.publish("remote:ssh-1", [{ file: files[1]!, revision: "still-live" }]);
  assert.equal(remote.length, 2);
  stopRemote();
  hub.dispose();
});

test("MW-H3: publish fences an inflight initial scan; unsubscribe prevents late notifications", async () => {
  const { hub, executor, target } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = executor.readFile;
  let paused = false;
  executor.readFile = async (path) => {
    const content = await original(path);
    if (path === files[0] && !paused) {
      paused = true;
      await gate;
    }
    return content;
  };
  const changes: NekWatchChange[] = [];
  const stop = hub.subscribe(target(), (change) => changes.push(change));
  await flush();
  assert.equal(paused, true);
  hub.publish("local", [{ file: files[0]!, revision: "new-published" }]);
  release();
  await flush();
  assert.deepEqual(
    changes.map((change) => change.revision),
    ["new-published"],
  );
  stop();
  hub.publish("local", [{ file: files[0]!, revision: "after-dispose" }]);
  assert.equal(changes.length, 1);
  hub.dispose();
});

test("MW-H4: scan errors are observable and an unchanged successful rescan reports recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { hub, executor, target } = setup();
  t.after(() => hub.dispose());
  const changes: NekWatchChange[] = [];
  const original = executor.listDir;
  executor.listDir = async () => {
    throw new Error("EACCES scan");
  };
  hub.subscribe(target(), (change) => changes.push(change));
  await flush();
  assert.match(changes[0]?.error?.message ?? "", /EACCES scan/);
  const late: NekWatchChange[] = [];
  const stopLate = hub.subscribe(target(), (change) => late.push(change));
  assert.match(
    late[0]?.error?.message ?? "",
    /EACCES scan/,
    "new leases inherit known watch failure",
  );
  stopLate();
  executor.listDir = original;
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(changes.some((change) => change.revision === "watch-recovered" && !change.error));
});

test("MW-H6: first observation closes the subscribe/prime gap even when the file was just created", async () => {
  const { hub, executor, target } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = executor.listDir;
  executor.listDir = async (path) => {
    await gate;
    return await original(path);
  };
  const changes: NekWatchChange[] = [];
  const stop = hub.subscribe(target(), (change) => changes.push(change));
  executor.setFile(files[0]!, '{"defaultModel":"during-prime"}');
  release();
  await flush();
  assert.ok(
    changes.some((change) => change.file === GLOBAL && change.revision === "watch-ready"),
    "notifying prime is required to fence a concurrent reader",
  );
  stop();
  hub.dispose();
});

test("MW-H7: auth.json edits participate in the same machine observation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { hub, executor, target } = setup();
  const changes: NekWatchChange[] = [];
  const stop = hub.subscribe(target(), (change) => changes.push(change));
  await flush();
  changes.length = 0;
  executor.setFile(join(GLOBAL, "auth.json"), '{"mock":{"type":"api_key","key":"test-only"}}');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(changes[0]?.file, join(GLOBAL, "auth.json"));
  stop();
  hub.dispose();
});

test("MW-H8: too many watched files fail visibly instead of growing observations without limit", async () => {
  const { hub, executor, target } = setup();
  for (let index = 0; index < 513; index += 1)
    executor.setFile(join(GLOBAL, `${index}.md`), "test");
  const changes: NekWatchChange[] = [];
  const stop = hub.subscribe(target(), (change) => changes.push(change));
  await flush();
  assert.match(changes[0]?.error?.message ?? "", /file capacity/);
  stop();
  hub.dispose();
});

test("MW-H9: a pending scan from a released lease cannot notify or overwrite its replacement", async () => {
  const { hub, executor, target } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = executor.listDir;
  let first = true;
  executor.listDir = async (path) => {
    if (first) {
      first = false;
      await gate;
    }
    return await original(path);
  };
  const old: NekWatchChange[] = [];
  const stopOld = hub.subscribe(target(), (change) => old.push(change));
  stopOld();
  const current: NekWatchChange[] = [];
  const stopCurrent = hub.subscribe(target(), (change) => current.push(change));
  await flush();
  const count = current.length;
  release();
  await flush();
  assert.equal(old.length, 0);
  assert.equal(current.length, count);
  stopCurrent();
  hub.dispose();
});

test("MW-H10: a successful file scan cannot swallow a live native watcher failure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const executor = createMemoryNekConfigHostExecutor();
  let nativeError: Error | undefined;
  let failNative!: (error: unknown) => void;
  const hub = new NekWatchHub({
    pollSeconds: 1,
    observeDirectory: (_path, _changed, failed) => {
      failNative = failed;
      return { refresh: () => undefined, error: () => nativeError, dispose: () => undefined };
    },
  });
  t.after(() => hub.dispose());
  const changes: NekWatchChange[] = [];
  hub.subscribe(
    { key: "local", local: true, executor, dirs: [{ path: GLOBAL, scope: "global" }] },
    (change) => changes.push(change),
  );
  await flush();
  changes.length = 0;
  nativeError = new Error("native watch EACCES");
  failNative(nativeError);
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(changes.every((change) => change.error?.message.includes("native watch EACCES")));
  changes.length = 0;
  nativeError = undefined;
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(changes.some((change) => change.revision === "watch-recovered"));
});

test("MW-H5: watch capacity rejects explicitly and releases all admitted directories", () => {
  const { hub, executor, target } = setup();
  const tooMany = {
    ...target(),
    dirs: Array.from({ length: 513 }, (_, index) => ({
      path: `/many/${index}`,
      scope: "project" as const,
    })),
  };
  assert.throws(() => hub.subscribe(tooMany, () => undefined), /capacity/);
  const one = hub.subscribe({ key: "local", executor, local: false, dirs: [] }, () => undefined);
  one();
  hub.dispose();
});
