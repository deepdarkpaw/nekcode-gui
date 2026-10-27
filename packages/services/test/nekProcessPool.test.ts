import assert from "node:assert/strict";
import test from "node:test";
import type { NekPooledProcess } from "../src/nek-agent/nekProcessPool.js";
import {
  NekProcessPool,
  NekProcessPoolCapacityError,
  NekProcessPoolDisposedError,
} from "../src/nek-agent/nekProcessPool.js";
import type { NekProcessPoolEvent } from "../src/nek-agent/nekProcessPool.js";

/**
 * 进程池的三条硬规则：同一会话只允许一个进程、上限（默认 8）到顶时先回收最久空闲的、
 * 正在跑回合的进程绝不回收。控制进程懒启动、崩溃后退避重启。
 */

interface FakeProcess extends NekPooledProcess {
  key: string;
  disposed: boolean;
  exitListeners: Set<() => void>;
  crash: () => void;
}

interface Harness {
  pool: NekProcessPool<FakeProcess>;
  created: string[];
  controlCreated: number;
  events: NekProcessPoolEvent[];
  processes: Map<string, FakeProcess>;
}

function createHarness(
  options: {
    maxSessions?: number;
    idleTimeoutMs?: number;
    now?: () => number;
    withControl?: boolean;
    controlBackoff?: { initialMs: number; maxMs: number };
  } = {},
): Harness {
  const created: string[] = [];
  const processes = new Map<string, FakeProcess>();
  const events: NekProcessPoolEvent[] = [];
  let controlCreated = 0;

  const create = (key: string): FakeProcess => {
    const exitListeners = new Set<() => void>();
    const process: FakeProcess = {
      key,
      disposed: false,
      exitListeners,
      dispose: () => {
        process.disposed = true;
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      crash: () => {
        for (const listener of Array.from(exitListeners)) listener();
      },
    };
    processes.set(key, process);
    return process;
  };

  const pool = new NekProcessPool<FakeProcess>({
    createSessionProcess: async (key) => {
      created.push(key);
      return create(key);
    },
    createControlProcess:
      options.withControl === false
        ? undefined
        : async () => {
            controlCreated += 1;
            return create("control");
          },
    maxSessions: options.maxSessions,
    idleTimeoutMs: options.idleTimeoutMs,
    now: options.now,
    controlRestartBackoff: options.controlBackoff,
    // 测试不让定时器自己跑：用 sweep() 与手动推进的时钟驱动回收。
    scheduleInterval: () => () => {},
  });
  pool.onEvent((event) => events.push(event));
  return {
    pool,
    created,
    events,
    processes,
    get controlCreated() {
      return controlCreated;
    },
  } as Harness;
}

test("one process per session key, reused on repeated acquire", async () => {
  const harness = createHarness();
  const first = await harness.pool.acquireSession("a");
  const second = await harness.pool.acquireSession("a");
  assert.equal(first, second);
  assert.deepEqual(harness.created, ["a"]);
  assert.equal(harness.pool.snapshot().sessions[0]?.refCount, 2);
  harness.pool.releaseSession("a");
  assert.equal(harness.pool.snapshot().sessions[0]?.refCount, 1);
  assert.deepEqual(
    harness.events.map((event) => event.type),
    ["session_created", "session_reused"],
  );
});

test("evicts the least recently used idle session at the cap", async () => {
  let now = 1_000;
  const harness = createHarness({ maxSessions: 2, now: () => now });
  await harness.pool.acquireSession("a");
  harness.pool.releaseSession("a");
  now += 10;
  await harness.pool.acquireSession("b");
  harness.pool.releaseSession("b");
  now += 10;
  // 已满 2：a 最久空闲，会被回收给 c 腾位置。
  await harness.pool.acquireSession("c");
  assert.deepEqual(harness.created, ["a", "b", "c"]);
  assert.equal(harness.processes.get("a")?.disposed, true);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === "session_reclaimed")
      .map((event) => event.sessionKey),
    ["a"],
  );
  assert.equal(harness.pool.sessionCount, 2);
});

test("refuses to evict busy or still-held sessions", async () => {
  const harness = createHarness({ maxSessions: 1 });
  await harness.pool.acquireSession("a");
  await assert.rejects(harness.pool.acquireSession("b"), (error: unknown) => {
    assert.ok(error instanceof NekProcessPoolCapacityError);
    assert.equal(error.maxSessions, 1);
    return true;
  });
  // 有回合在跑时即使引用归零也不回收。
  harness.pool.releaseSession("a");
  harness.pool.beginTurn("a");
  await assert.rejects(harness.pool.acquireSession("b"), NekProcessPoolCapacityError);
  harness.pool.endTurn("a");
  await harness.pool.acquireSession("b");
  assert.equal(harness.processes.get("a")?.disposed, true);
});

test("sweep reclaims only sessions idle past the threshold", async () => {
  let now = 0;
  const harness = createHarness({ idleTimeoutMs: 1_000, now: () => now });
  await harness.pool.acquireSession("idle");
  harness.pool.releaseSession("idle");
  await harness.pool.acquireSession("busy");
  harness.pool.releaseSession("busy");
  harness.pool.beginTurn("busy");
  now = 2_000;
  await harness.pool.sweep();
  assert.equal(harness.processes.get("idle")?.disposed, true);
  // 回合没结束：不能回收。
  assert.equal(harness.processes.get("busy")?.disposed, false);
  harness.pool.endTurn("busy");
  // endTurn 会把 lastUsedAt 推到当前时刻：还要再等一个空闲窗口才会被回收。
  now = 4_000;
  await harness.pool.sweep();
  assert.equal(harness.processes.get("busy")?.disposed, true);
  assert.equal(harness.pool.sessionCount, 0);
});

test("a crashed session process is dropped and reported", async () => {
  const harness = createHarness();
  await harness.pool.acquireSession("a");
  harness.processes.get("a")?.crash();
  assert.equal(harness.pool.sessionCount, 0);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === "session_reclaimed")
      .map((event) => event.reason),
    ["crashed"],
  );
  // 重建一个新进程而不是复用已死的。
  await harness.pool.acquireSession("a");
  assert.deepEqual(harness.created, ["a", "a"]);
});

test("control process is lazy, shared and restarted with backoff", async () => {
  const harness = createHarness({ withControl: true, controlBackoff: { initialMs: 5, maxMs: 20 } });
  assert.equal(harness.controlCreated, 0);
  const first = await harness.pool.ensureControl();
  const second = await harness.pool.ensureControl();
  assert.equal(first, second);
  assert.equal(harness.controlCreated, 1);
  // 崩溃 → 退避后自动重启。
  harness.processes.get("control")?.crash();
  assert.equal(harness.pool.control, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.controlCreated, 2);
  const scheduled = harness.events.filter((event) => event.type === "control_restart_scheduled");
  assert.equal(scheduled.length, 1);
  assert.deepEqual(harness.events.filter((event) => event.type === "control_started").length, 2);
});

test("ensureControl without a factory is an explicit error", async () => {
  const harness = createHarness({ withControl: false });
  await assert.rejects(harness.pool.ensureControl(), /control process factory/u);
});

test("dispose closes every session and the control process", async () => {
  const harness = createHarness();
  await harness.pool.acquireSession("a");
  await harness.pool.acquireSession("b");
  await harness.pool.ensureControl();
  await harness.pool.dispose();
  assert.equal(harness.processes.get("a")?.disposed, true);
  assert.equal(harness.processes.get("b")?.disposed, true);
  assert.equal(harness.processes.get("control")?.disposed, true);
  await assert.rejects(harness.pool.acquireSession("c"), NekProcessPoolDisposedError);
});

test("reclaimSession closes a specific session without touching others", async () => {
  const harness = createHarness();
  await harness.pool.acquireSession("a");
  await harness.pool.acquireSession("b");
  await harness.pool.reclaimSession("a");
  assert.equal(harness.processes.get("a")?.disposed, true);
  assert.equal(harness.processes.get("b")?.disposed, false);
  assert.equal(harness.pool.sessionCount, 1);
});
