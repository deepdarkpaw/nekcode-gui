/**
 * nek workspace runtime 生命周期回归。
 *
 * 现场（2026-10-31）：工厂把代际游标做成跨订阅者共享，却给每个订阅者单独挂一条
 * `service.onEvent`。第一个订阅者收到 available 时顺手清掉共享的 `unavailable`，
 * 其余订阅者再也收不到恢复帧——dormant 的 sessions-index 观察者永久休眠。
 *
 * 这里锁定新的语义：一个 workspace runtime 由“还有挂接进程的会话”定义，单个会话
 * 关闭/崩溃不等于 workspace 不可用；一次事实只计算一次并广播给全部监听者；正常关闭
 * 不制造 unavailable；代际查询与事件共用同一份记忆。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAgentRuntimeLifecycleEvent } from "../src/zcode-agent/zcodeAgent.js";
import {
  createNekAgentRuntimeLifecycle,
  NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES,
} from "../src/nek-agent/adapter/nekAgentRuntimeLifecycle.js";
import type { NekAgentServiceEvent, NekSession } from "../src/nek-agent/service/types.js";

/** 会话记录表的替身：只保留 owner 需要回答的两个事实（进程是否挂接、属于哪个 workspace）。 */
function createRuntimeHarness() {
  const sessions = new Map<string, NekSession>();
  const live = new Set<string>();
  const listeners = new Set<(event: NekAgentServiceEvent) => void>();

  const emit = (event: NekAgentServiceEvent): void => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const sessionOf = (sessionKey: string): NekSession => {
    const session = sessions.get(sessionKey);
    assert.ok(session, `unknown test session ${sessionKey}`);
    return session;
  };
  const read = (sessionKey: string, cwd: string): NekSession => ({
    sessionKey,
    sessionId: sessionKey,
    sessionPath: `${cwd}/${sessionKey}.jsonl`,
    cwd,
    phase: "idle",
    readonly: false,
  });

  const source = {
    onEvent(listener: (event: NekAgentServiceEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasLiveSessionProcess(workspacePath: string): boolean {
      for (const sessionKey of live) {
        if (sessions.get(sessionKey)?.cwd === workspacePath) return true;
      }
      return false;
    },
  };

  return {
    source,
    listenerCount: () => listeners.size,
    /** 会话拿到（或重新拿到）一个可用进程。 */
    attach(sessionKey: string, cwd: string): void {
      const session = read(sessionKey, cwd);
      sessions.set(sessionKey, session);
      live.add(sessionKey);
      emit({ type: "process_attached", session });
    },
    /** 进程非正常退出：记录仍在，phase 变成 error 且不再持有进程。 */
    crash(sessionKey: string): void {
      const session = sessionOf(sessionKey);
      live.delete(sessionKey);
      emit({
        type: "process_exit",
        session: { ...session, phase: "error" },
        exit: { code: 1, signal: null },
      });
    },
    /** 主动关闭：服务层只移除记录，不发任何事件。 */
    close(sessionKey: string): void {
      live.delete(sessionKey);
      sessions.delete(sessionKey);
    },
    /** 存活期间的 phase 变化（含 error/locked），都不是生命周期事实。 */
    phase(sessionKey: string, previous: NekSession["phase"], state: NekSession["phase"]): void {
      const session = sessionOf(sessionKey);
      sessions.set(sessionKey, { ...session, phase: state });
      emit({ type: "state", session: { ...session, phase: state }, previous, state });
    },
  };
}

function collect(lifecycle: {
  onDidChange: (listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) => { dispose(): void };
}) {
  const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
  const subscription = lifecycle.onDidChange((event) => frames.push(event));
  return { frames, subscription };
}

const shape = (frames: ZCodeAgentRuntimeLifecycleEvent[]) =>
  frames.map((frame) => [frame.state, frame.runtimeIdentity.generation]);

test("首个会话进程挂上发一次 available，代际与 identity 查询一致", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  assert.deepEqual(lifecycle.getIdentity("/workspace/p1"), {
    generation: 1,
    identity: "nek:/workspace/p1",
    workspaceKey: "/workspace/p1",
  });

  // 发给 dormant 观察者的第一条事实：runtime 从这一代开始可用。
  harness.attach("s1", "/workspace/p1");
  assert.deepEqual(frames, [
    {
      workspacePath: "/workspace/p1",
      workspaceKey: "/workspace/p1",
      runtimeIdentity: {
        generation: 1,
        identity: "nek:/workspace/p1",
        workspaceKey: "/workspace/p1",
      },
      state: "available",
    },
  ]);
  // 查询与事件必须给出同一个代际，否则观察者会把新代判成旧代。
  assert.equal(lifecycle.getIdentity("/workspace/p1").generation, 1);
  // 查询本身不是事实来源，不能制造事件。
  assert.equal(frames.length, 1);
  lifecycle.dispose();
});

test("多监听者共享一次计算：崩溃与恢复都广播给全部订阅者", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const first = collect(lifecycle);
  const second = collect(lifecycle);
  const third = collect(lifecycle);

  harness.attach("s1", "/workspace/p");
  assert.deepEqual(shape(first.frames), [["available", 1]]);
  assert.deepEqual(shape(second.frames), [["available", 1]]);
  assert.deepEqual(shape(third.frames), [["available", 1]]);

  harness.crash("s1");
  harness.attach("s1", "/workspace/p");
  for (const { frames } of [first, second, third]) {
    assert.deepEqual(shape(frames), [
      ["available", 1],
      ["unavailable", 1],
      ["available", 2],
    ]);
  }

  // 单个监听者退订不影响其余监听者，也不影响记账。
  second.subscription.dispose();
  harness.crash("s1");
  assert.deepEqual(shape(first.frames), [
    ["available", 1],
    ["unavailable", 1],
    ["available", 2],
    ["unavailable", 2],
  ]);
  assert.deepEqual(shape(second.frames), [
    ["available", 1],
    ["unavailable", 1],
    ["available", 2],
  ]);
  assert.deepEqual(shape(third.frames).at(-1), ["unavailable", 2]);
  lifecycle.dispose();
});

test("同 workspace 多会话：最后一个存活进程消失才算 workspace 不可用", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("a", "/workspace/p");
  harness.attach("b", "/workspace/p");
  // 第二个会话挂进程只是 workspace 内部的又一次可用事实，不换代。
  assert.deepEqual(shape(frames), [["available", 1]]);

  harness.crash("a");
  assert.deepEqual(shape(frames), [["available", 1]]);

  harness.crash("b");
  assert.deepEqual(shape(frames), [
    ["available", 1],
    ["unavailable", 1],
  ]);

  // 任一会话重新挂进程即恢复，且只换代一次。
  harness.attach("b", "/workspace/p");
  assert.deepEqual(shape(frames), [
    ["available", 1],
    ["unavailable", 1],
    ["available", 2],
  ]);
  lifecycle.dispose();
});

test("正常关闭不伪造 unavailable，重开也不换代", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("s1", "/workspace/p");
  harness.close("s1");
  assert.deepEqual(shape(frames), [["available", 1]]);
  assert.equal(harness.source.hasLiveSessionProcess("/workspace/p"), false);

  // 关闭后重新打开：仍是同一代，观察者不必重订阅。
  harness.attach("s2", "/workspace/p");
  assert.deepEqual(shape(frames), [["available", 1]]);
  assert.equal(lifecycle.getIdentity("/workspace/p").generation, 1);
  lifecycle.dispose();
});

test("phase 抖动、error 与 locked 都不是恢复信号", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("s1", "/workspace/p");
  harness.phase("s1", "idle", "running");
  harness.phase("s1", "running", "waiting_input");
  harness.phase("s1", "waiting_input", "error");
  harness.phase("s1", "error", "locked");
  assert.deepEqual(shape(frames), [["available", 1]]);

  // 崩溃后 phase 事件不能把 workspace 拉回 available——只有重新挂进程才行。
  harness.crash("s1");
  harness.phase("s1", "error", "idle");
  assert.deepEqual(shape(frames), [
    ["available", 1],
    ["unavailable", 1],
  ]);
  lifecycle.dispose();
});

test("不同 workspace 领取互不重复、单调递增的代际票据", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("a", "/workspace/a");
  harness.attach("b", "/workspace/b");
  harness.attach("c", "/workspace/c");
  const generations = frames.map((frame) => frame.runtimeIdentity.generation);
  assert.equal(new Set(generations).size, 3);
  assert.deepEqual(
    generations,
    [...generations].sort((left, right) => left - right),
  );
  lifecycle.dispose();
});

test("活跃 workspace 不被回收；冷 workspace 的 identity 查询挤不掉它的代际", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("hot", "/workspace/hot");
  const hotGeneration = frames[0]?.runtimeIdentity.generation;
  assert.equal(lifecycle.getIdentity("/workspace/hot").generation, hotGeneration);

  // 大量冷 workspace（只查询、不起进程）也会占表；不能把活跃 workspace 的记忆淘汰掉。
  for (let index = 0; index < NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES * 2; index += 1) {
    assert.ok(lifecycle.getIdentity(`/cold/${index}`).generation > 0);
  }
  assert.equal(lifecycle.getIdentity("/workspace/hot").generation, hotGeneration);

  // 记忆还在：崩溃时报告的仍是同一个代际，而不是重建后的新号。
  frames.length = 0;
  harness.crash("hot");
  assert.deepEqual(shape(frames), [["unavailable", hotGeneration]]);
  lifecycle.dispose();
});

test("慢 workspace 在新 workspace 高频使用后回来，代际不回退也不重复", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);

  harness.attach("slow", "/workspace/slow");
  harness.crash("slow");
  const firstGeneration = frames[0]?.runtimeIdentity.generation;
  assert.deepEqual(shape(frames), [
    ["available", firstGeneration],
    ["unavailable", firstGeneration],
  ]);

  // 用一个远超表容量的 workspace 轮换把它挤出记忆（每个都建立并崩溃）。
  for (let index = 0; index < NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES * 2; index += 1) {
    harness.attach(`churn-${index}`, `/workspace/churn-${index}`);
    harness.crash(`churn-${index}`);
  }

  frames.length = 0;
  harness.attach("slow", "/workspace/slow");
  const recovered = frames[0]?.runtimeIdentity.generation;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.state, "available");
  // 关键：淘汰过记忆也不能回到旧号，观察者不会把新代当成旧代。
  assert.ok(recovered !== undefined);
  assert.ok(recovered > firstGeneration, `${recovered} should be greater than ${firstGeneration}`);
  assert.equal(lifecycle.getIdentity("/workspace/slow").generation, recovered);
  lifecycle.dispose();
});

test("identity 读取淘汰全活跃表后不重复旧 generation，恢复事件与新查询仍同代", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);
  for (let index = 0; index < NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES; index += 1) {
    harness.attach(`active-${index}`, `/active/${index}`);
  }
  const oldGeneration = frames[0]!.runtimeIdentity.generation;
  // Touch every other active entry: /active/0 is now the LRU of an entirely active table.
  for (let index = 1; index < NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES; index += 1) {
    lifecycle.getIdentity(`/active/${index}`);
  }
  lifecycle.getIdentity("/cold/read-only");
  const replacement = lifecycle.getIdentity("/active/0").generation;
  assert.ok(replacement > oldGeneration);
  assert.ok(replacement > NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES);
  // The query has no event side effects. The next process fact uses the newly reserved ticket.
  assert.equal(frames.length, NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES);
  harness.attach("active-0", "/active/0");
  assert.equal(frames.at(-1)!.runtimeIdentity.generation, replacement);
  assert.equal(lifecycle.getIdentity("/active/0").generation, replacement);
  lifecycle.dispose();
});

test("一个监听者抛错不影响其它监听者，错误仍冒泡给服务层记录", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const healthy: ZCodeAgentRuntimeLifecycleEvent[] = [];
  lifecycle.onDidChange(() => {
    throw new Error("listener boom");
  });
  lifecycle.onDidChange((event) => healthy.push(event));

  assert.throws(() => harness.attach("s1", "/workspace/p"), /listener boom/u);
  assert.deepEqual(shape(healthy), [["available", 1]]);
  lifecycle.dispose();
});

test("dispose 之后脱离服务订阅，不再广播也不再记账", () => {
  const harness = createRuntimeHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.source);
  const { frames } = collect(lifecycle);
  assert.equal(harness.listenerCount(), 1);

  lifecycle.dispose();
  assert.equal(harness.listenerCount(), 0);
  harness.attach("s1", "/workspace/p");
  assert.deepEqual(frames, []);
  // 终结之后的订阅是空实现（与 Emitter.dispose 的口径一致），不能把监听者留在表里。
  assert.doesNotThrow(() => lifecycle.onDidChange(() => undefined).dispose());
  assert.doesNotThrow(() => lifecycle.dispose());
});
