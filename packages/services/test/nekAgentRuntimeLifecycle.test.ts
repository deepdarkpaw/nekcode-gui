/**
 * nek runtime 生命周期投影回归。
 *
 * 渲染层与 host 观察者都靠 `onAgentRuntimeLifecycle` 判断换代：unavailable 必须由
 * 会话进程退出触发，available 必须只在真正恢复后发一次——重复 available 会让
 * sessions-index 观察者反复重订阅，永不 available 则会让 dormant 观察者永久休眠。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAgentRuntimeLifecycleEvent } from "../src/zcode-agent/zcodeAgent.js";
import {
  createNekAgentRuntimeLifecycle,
  NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES,
} from "../src/nek-agent/adapter/nekAgentRuntimeLifecycle.js";
import type { NekAgentServiceEvent, NekSession } from "../src/nek-agent/service/types.js";

function session(cwd: string, phase: NekSession["phase"] = "running"): NekSession {
  return {
    sessionKey: `${cwd}/s1.jsonl`,
    sessionId: "s1",
    sessionPath: `${cwd}/s1.jsonl`,
    cwd,
    phase,
    readonly: false,
  };
}

function createSource() {
  const listeners = new Set<(event: NekAgentServiceEvent) => void>();
  return {
    emit(event: NekAgentServiceEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    onEvent(listener: (event: NekAgentServiceEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const exit = (cwd: string): NekAgentServiceEvent =>
  ({
    type: "process_exit",
    session: session(cwd, "error"),
    exit: { code: 1, signal: null },
  }) as NekAgentServiceEvent;

const state = (
  cwd: string,
  previous: NekSession["phase"],
  next: NekSession["phase"],
): NekAgentServiceEvent =>
  ({ type: "state", session: session(cwd, next), previous, state: next }) as NekAgentServiceEvent;

test("进程退出发 unavailable，恢复后只补一次 available 并递增代际", () => {
  const source = createSource();
  const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
  const subscription = createNekAgentRuntimeLifecycle(source)((event) => frames.push(event));
  const cwd = "/workspace/project";

  source.emit(exit(cwd));
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { ...frames[0], runtimeIdentity: { ...frames[0]?.runtimeIdentity } },
    {
      workspacePath: cwd,
      workspaceKey: cwd,
      runtimeIdentity: {
        generation: 1,
        identity: `nek:${cwd}`,
        workspaceKey: cwd,
      },
      state: "unavailable",
    },
  );

  source.emit(state(cwd, "error", "idle"));
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.state, "available");
  assert.equal(frames[1]?.runtimeIdentity.generation, 2);

  // 存活期间的 phase 抖动不是换代。
  source.emit(state(cwd, "idle", "running"));
  assert.equal(frames.length, 2);

  // 下一次退出仍然只是一次换代。
  source.emit(exit(cwd));
  source.emit(state(cwd, "error", "running"));
  assert.deepEqual(
    frames.slice(2).map((frame) => [frame.state, frame.runtimeIdentity.generation]),
    [
      ["unavailable", 2],
      ["available", 3],
    ],
  );

  subscription.dispose();
  assert.equal(source.listenerCount(), 0);
});

test("没有退出的存活事件不产生 available，error 与 locked 也不算恢复", () => {
  const source = createSource();
  const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
  createNekAgentRuntimeLifecycle(source)((event) => frames.push(event));
  const cwd = "/workspace/project";

  source.emit(state(cwd, "idle", "running"));
  source.emit(exit(cwd));
  source.emit(state(cwd, "running", "error"));
  source.emit(state(cwd, "error", "locked"));
  assert.deepEqual(
    frames.map((frame) => frame.state),
    ["unavailable"],
  );
});

test("不同 workspace 的代际互相独立，且代际表有界", () => {
  const source = createSource();
  const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
  createNekAgentRuntimeLifecycle(source)((event) => frames.push(event));

  const workspaces = Array.from(
    { length: NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES + 8 },
    (_, index) => `/workspace/p${index}`,
  );
  for (const cwd of workspaces) source.emit(exit(cwd));
  assert.equal(frames.length, workspaces.length);
  assert.ok(frames.every((frame) => frame.runtimeIdentity.generation === 1));

  // 最近用过的 workspace 仍然只有自己的代际：表被淘汰也只会退回初始代际，不会串台。
  const recent = workspaces.at(-1)!;
  frames.length = 0;
  source.emit(state(recent, "error", "running"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.workspacePath, recent);
  assert.equal(frames[0]?.state, "available");
});
