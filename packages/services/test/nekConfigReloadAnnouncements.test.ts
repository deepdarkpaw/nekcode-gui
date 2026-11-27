import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  NekConfigTarget,
  NekReloadResult,
  NekSessionReloadOutcome,
} from "@zcode/shared/nek-protocol";
import {
  createLocalNekConfigHostExecutor,
  NekConfigApi,
  type NekConfigHostExecutor,
  type NekConfigSessionHandle,
} from "../src/nek-config-api/index.js";
import { NekConfigRuntime } from "../src/nek-config-api/runtime.js";
import {
  announcementPath,
  writeReloadAnnouncement,
} from "../src/nek-config-api/reloadAnnouncements.js";
import { FakeControlClient } from "./nekConfigApiHarness.js";

const LOCAL = { kind: "local" } as const;
const REMOTE = { kind: "remote", connectionId: "target" } as const;
const OK: NekReloadResult = { deferred: false, diagnostics: [] };

async function fixture(t: TestContext) {
  const base = resolve(".tmp", "nek-reload-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "machine-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const executor = createLocalNekConfigHostExecutor({ home: root });
  return { root, executor, journal: announcementPath(executor.agentDir()) };
}

function options(
  executor: NekConfigHostExecutor,
  sessions: NekConfigSessionHandle[] = [],
  control = new FakeControlClient(),
) {
  return {
    hosts: { executor: () => executor, listTargets: async () => [] },
    config: { watchDebounceMs: 20, remoteConfigPollSeconds: 1 },
    control: async () => control,
    sessions: { sessions: (target: NekConfigTarget) => (target.kind === "local" ? sessions : []) },
  };
}

function runtime(t: TestContext, ...args: Parameters<typeof options>) {
  const owner = new NekConfigRuntime(options(...args));
  t.after(() => owner.dispose());
  return owner;
}

function task(
  cwd: string,
  reload: () => Promise<NekReloadResult>,
  isLive?: () => boolean,
): NekConfigSessionHandle {
  return {
    sessionKey: cwd,
    cwd,
    busy: false,
    isLive,
    call: reload as NekConfigSessionHandle["call"],
  };
}

function capture(owner: Pick<NekConfigApi, "onReloadResult">, target = LOCAL as NekConfigTarget) {
  const received: NekSessionReloadOutcome[] = [];
  owner.onReloadResult(target, (result) => received.push(result));
  return received;
}

async function until(check: () => boolean, message = "expected reload results") {
  const deadline = Date.now() + 8_000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message);
}

async function readJournal(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    trigger: "write" | "login" | "manual";
    files: string[];
    cwd?: string;
    previous: Array<{ id: string; trigger: string; cwd?: string }>;
    truncated?: boolean;
  };
}

void test("only same-machine owners see a main write, including a first write before agentDir exists", async (t) => {
  const { executor, journal } = await fixture(t);
  const other = await fixture(t);
  const control = new FakeControlClient();
  const origin = new NekConfigApi(options(executor, [], control));
  t.after(() => origin.dispose());
  const observerControl = new FakeControlClient();
  const a = runtime(t, executor, [], observerControl);
  a.modelRuntime(LOCAL).register({
    sessionKey: "a",
    cwd: "/a",
    isWritable: () => true,
    call: async () => assert.fail("reload must go through the live writer lease"),
    reload: async () => OK,
    rebindModel: async () => undefined,
  });
  const b = runtime(t, executor, [task("/b", async () => ({ ...OK, deferred: true }))]);
  const isolated = runtime(t, other.executor, [
    task("/other", async () => assert.fail("other host")),
  ]);
  const [ra, rb, ri] = [a, b, isolated].map((owner) => capture(owner));
  for (const owner of [a, b, isolated]) owner.observeAnnouncements(LOCAL);

  await a.control(LOCAL);
  await origin.getAuthStatus(LOCAL);
  const before = await origin.readSettings(LOCAL, "global");
  await origin.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "x/y" },
    { revision: before.revision },
  );
  assert.deepEqual((await readJournal(journal)).files, ["settings.json"]);
  await until(() => ra!.length > 0 && rb!.length > 0);
  assert.deepEqual(ra, [
    { reloaded: 1, deferred: 0, failures: [], diagnostics: [], trigger: "write" },
  ]);
  assert.deepEqual(rb, [
    { reloaded: 0, deferred: 1, failures: [], diagnostics: [], trigger: "write" },
  ]);
  assert.deepEqual(ri, []);

  const manual = await origin.reloadRunningSessions(LOCAL);
  assert.deepEqual(manual, {
    trigger: "manual",
    announced: true,
    reloaded: 0,
    deferred: 0,
    diagnostics: [],
    failures: [],
  });
  await until(() => ra!.length === 2 && rb!.length === 2);
  assert.equal(ra![1]?.trigger, "manual");
  assert.equal(rb![1]?.trigger, "manual");
  assert.equal(control.commands.filter(({ type }) => type === "reload").length, 2);
  assert.equal(observerControl.commands.filter(({ type }) => type === "reload").length, 0);
});

void test("rapid scoped writes and manual requests coalesce without widening or reloading the author twice", async (t) => {
  const { executor, journal } = await fixture(t);
  const first = resolve("workspace-a");
  const second = resolve("workspace-b");
  const ignored = resolve("workspace-c");
  const calls: string[] = [];
  const record = (key: string) => async () => {
    calls.push(key);
    return OK;
  };
  const author = runtime(t, executor, [task(first, record("author"))]);
  const peer = runtime(t, executor, [
    task(first, record("a")),
    task(second, record("b")),
    task(ignored, record("c")),
  ]);
  const peerResults = capture(peer);
  author.observeAnnouncements(LOCAL);
  peer.observeAnnouncements(LOCAL);
  const change = (cwd: string) => ({ path: join(cwd, ".nek", "settings.json"), revision: "1" });
  await author.publishWrite(LOCAL, [change(first), change(second)]);
  await until(() => peerResults.length === 1 && calls.length === 3);
  assert.deepEqual([...calls].sort(), ["a", "author", "b"]);
  assert.equal(peerResults[0]?.reloaded, 2);
  assert.equal((await readJournal(journal)).previous.length, 1);

  const manual = await author.reloadRunningSessions(LOCAL, `${first}/`);
  assert.equal(manual.reloaded, 1);
  assert.equal(manual.announced, true, JSON.stringify(manual.failures));
  await until(() => peerResults.length === 2);
  assert.equal(peerResults[1]?.trigger, "manual");
  await delay(80);
  assert.deepEqual([...calls].sort(), ["a", "a", "author", "author", "b"]);
});

void test("a write during a reload is not lost; retired sessions are skipped and failures can be retried", async (t) => {
  const { executor } = await fixture(t);
  const a = resolve("a");
  const b = resolve("b");
  const c = resolve("c");
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let callCount = 0;
  let live = true;
  let cCalls = 0;
  const owner = runtime(t, executor, [
    task(a, async () => {
      if (++callCount === 1) {
        entered.resolve();
        await released.promise;
        throw new Error("RPC process exited");
      }
      return OK;
    }),
    task(
      b,
      async () => assert.fail("stale handle"),
      () => live,
    ),
    task(c, async () => {
      cCalls += 1;
      return OK;
    }),
  ]);
  const author = runtime(t, executor);
  const results = capture(owner);
  owner.observeAnnouncements(LOCAL);
  await author.publishWrite(LOCAL, [
    { path: join(executor.agentDir(), "mcp.json"), revision: "one" },
  ]);
  await until(() => callCount === 1);
  await entered.promise;
  live = false;
  await author.publishWrite(LOCAL, [{ path: join(a, ".nek", "settings.json"), revision: "two" }]);
  released.resolve();
  await until(() => results.length === 2);
  assert.equal(results[0]?.reloaded, 1);
  assert.equal(results[0]?.failures[0]?.message, "RPC process exited");
  assert.equal(results[1]?.reloaded, 1);
  assert.equal(cCalls, 1);
  assert.equal(callCount, 2);
});

void test("journal starts at a cursor, expires bounded history explicitly, and does not replay on repeat scans", async (t) => {
  const { executor, journal } = await fixture(t);
  const cwd = resolve("journal-project");
  const origin = "external";
  await writeReloadAnnouncement(executor, journal, origin, [{ trigger: "manual", files: [], cwd }]);
  const oldJournal = await readFile(journal, "utf8");
  const owner = runtime(t, executor, [task(cwd, async () => OK)]);
  const results = capture(owner);
  owner.observeAnnouncements(LOCAL);
  // One atomic batch larger than the space left by the initial record, followed by a new cursor.
  await writeReloadAnnouncement(
    executor,
    journal,
    origin,
    Array.from({ length: 64 }, () => ({ trigger: "manual", files: [], cwd })),
  );
  const state = await readJournal(journal);
  assert.equal(state.truncated, true);
  assert.equal(state.previous.length, 63);
  await until(() => results.length === 2);
  assert.match(results[0]?.failures[0]?.message ?? "", /expired.*retry/i);
  assert.equal(results[1]?.reloaded, 1);
  await executor.lock!.runLocked(journal, () => oldJournal, { maxBytes: 48 * 1024 });
  await delay(1100);
  assert.equal(results.length, 2, "a replayed old ID must not reload again");
});

void test("publication and diagnostic errors are explicit, and a fresh manual request retries without replaying the write", async (t) => {
  const { executor } = await fixture(t);
  const lock = executor.lock!;
  let fail = true;
  executor.lock = {
    runLocked: (path, critical, atomic) => {
      if (atomic && fail) throw new Error("read-only mount");
      return lock.runLocked(path, critical, atomic);
    },
  };
  const owner = runtime(t, executor, [
    task("/p", async () =>
      fail
        ? {
            ...OK,
            diagnostics: [
              { file: "settings.json", severity: "error", message: "invalid settings" },
            ],
          }
        : OK,
    ),
  ]);
  const results = capture(owner);
  await owner.publishWrite(LOCAL, [
    { path: join(executor.agentDir(), "settings.json"), revision: "1" },
  ]);
  await until(() => results.length === 1);
  assert.equal(results[0]?.announced, false);
  assert.equal(results[0]?.reloaded, 0);
  assert.deepEqual(
    results[0]?.failures.map(({ sessionKey }) => sessionKey),
    ["announcement", "/p"],
  );
  const failed = await owner.reloadRunningSessions(LOCAL);
  assert.equal(failed.announced, false);
  assert.match(failed.failures[0]?.message ?? "", /read-only.*retry/i);
  fail = false;
  const retry = await owner.reloadRunningSessions(LOCAL);
  assert.equal(retry.announced, true);
  assert.equal(retry.reloaded, 1);
  assert.deepEqual(retry.failures, []);
});

void test("successful login, logout, file copy and login-only copy notify only the destination", async (t) => {
  const source = await fixture(t);
  const dest = await fixture(t);
  const control = new FakeControlClient();
  const api = new NekConfigApi({
    ...options(source.executor, [], control),
    hosts: {
      executor: (target) => (target.kind === "local" ? source.executor : dest.executor),
      listTargets: async () => [],
    },
  });
  t.after(() => api.dispose());
  const publisherResults = capture(api, REMOTE);
  const peer = runtime(t, dest.executor, [task("/target", async () => OK)]);
  const results = capture(peer);
  peer.observeAnnouncements(LOCAL);

  const login = await api.startLogin(REMOTE, "anthropic");
  const done = Promise.withResolvers<void>();
  const stop = api.onLoginEvent(login.loginId, (event) => {
    if (event.type === "done") done.resolve();
  });
  control.completeLogin();
  await done.promise;
  stop();
  assert.equal((await readJournal(dest.journal)).trigger, "login");
  await until(() => results.length === 1);

  await api.logout(REMOTE, "anthropic");
  assert.equal((await readJournal(dest.journal)).previous.length, 1);
  await until(() => results.length === 2);

  const loginOnly = api.copy(
    LOCAL,
    REMOTE,
    { providers: [], logins: ["anthropic"], mcpServers: [] },
    {},
  );
  await until(() => control.commands.filter(({ type }) => type === "auth_login").length === 2);
  control.completeLogin();
  assert.deepEqual(await loginOnly, { items: [{ key: "login:anthropic", status: "copied" }] });
  assert.equal((await readJournal(dest.journal)).trigger, "login");
  await until(() => results.length === 3);

  await source.executor.writeFileAtomic(
    join(source.executor.agentDir(), "settings.json"),
    '{"defaultModel":"p/m"}',
  );
  const copied = await api.copy(
    LOCAL,
    REMOTE,
    { providers: [], logins: [], mcpServers: [], defaults: true },
    {},
  );
  assert.deepEqual(copied, { items: [{ key: "defaults:defaults", status: "copied" }] });
  assert.equal(
    (await readJournal(dest.journal)).trigger,
    "write",
    JSON.stringify(publisherResults),
  );
  await until(() => results.length === 4);
  await assert.rejects(() => readFile(source.journal), { code: "ENOENT" });
  assert.deepEqual(
    results.map(({ trigger }) => trigger),
    ["login", "login", "login", "write"],
  );

  const journalBeforeFailure = await readFile(dest.journal, "utf8");
  const failed = await api.startLogin(REMOTE, "anthropic");
  const failure = Promise.withResolvers<string>();
  api.onLoginEvent(failed.loginId, (event) => {
    if (event.type === "failed") failure.resolve(event.message);
  });
  control.failLogin("denied");
  assert.equal(await failure.promise, "denied");
  assert.equal(await readFile(dest.journal, "utf8"), journalBeforeFailure);
});
