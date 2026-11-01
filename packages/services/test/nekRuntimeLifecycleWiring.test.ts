/**
 * 适配层接线回归：`getWorkspaceRuntimeIdentity` 与 `onAgentRuntimeLifecycle` 必须共用同一份
 * 代际记忆。
 *
 * 现场（2026-10-31）：身份查询恒返回 generation=1，事件却随换代自增。渲染层拿 identity
 * 判定“是不是同一代 runtime”时，第一次恢复之后就对不上，旧订阅被当成新代保留。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAgentRuntimeLifecycleEvent } from "../src/zcode-agent/zcodeAgent.js";
import { createNekLegacyMethods } from "../src/nek-agent/adapter/nekAgentServiceAdapterLegacy.js";
import type { NekAgentServiceAdapterLegacyTarget } from "../src/nek-agent/adapter/nekAgentServiceAdapterLegacySupport.js";
import type { NekAgentServiceEvent, NekSession } from "../src/nek-agent/service/types.js";

const session = (sessionKey: string, cwd: string, phase: NekSession["phase"]): NekSession => ({
  sessionKey,
  sessionId: sessionKey,
  sessionPath: `${cwd}/${sessionKey}.jsonl`,
  cwd,
  phase,
  readonly: false,
});

/** 只实现 legacy 方法构造与生命周期用到的最小服务面，其余成员一访问就报错。 */
function createTarget() {
  const listeners = new Set<(event: NekAgentServiceEvent) => void>();
  const live = new Set<string>();
  const cwdOf = new Map<string, string>();
  const emit = (event: NekAgentServiceEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const service = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "onEvent")
          return (listener: (event: NekAgentServiceEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          };
        if (property === "hasLiveSessionProcess")
          return (workspacePath: string) => {
            for (const sessionKey of live) {
              if (cwdOf.get(sessionKey) === workspacePath) return true;
            }
            return false;
          };
        throw new Error(`fake nek service does not implement ${String(property)}`);
      },
    },
  );
  return {
    target: { service } as unknown as NekAgentServiceAdapterLegacyTarget,
    attach(sessionKey: string, cwd: string) {
      cwdOf.set(sessionKey, cwd);
      live.add(sessionKey);
      emit({ type: "process_attached", session: session(sessionKey, cwd, "idle") });
    },
    crash(sessionKey: string) {
      const cwd = cwdOf.get(sessionKey);
      assert.ok(cwd);
      live.delete(sessionKey);
      emit({
        type: "process_exit",
        session: session(sessionKey, cwd, "error"),
        exit: { code: 1, signal: null },
      });
    },
    async dispose() {
      listeners.clear();
    },
  };
}

test("identity 查询与生命周期事件共用同一份代际", async () => {
  const { target, attach, crash, dispose } = createTarget();
  const methods = createNekLegacyMethods(target, async () => ({
    available: true,
    providerCount: 1,
    defaultSelection: null,
  }));
  const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
  const subscription = methods.onAgentRuntimeLifecycle?.((event) => frames.push(event));
  assert.ok(subscription);

  const identity = methods.getWorkspaceRuntimeIdentity;
  assert.ok(identity);
  assert.equal((await identity({ workspacePath: "/w" })).generation, 1);

  attach("s1", "/w");
  assert.deepEqual(
    frames.map((frame) => [frame.state, frame.runtimeIdentity.generation]),
    [["available", 1]],
  );
  // 恢复之后查询必须跟着事件走，不能仍是初值。
  crash("s1");
  attach("s1", "/w");
  assert.equal((await identity({ workspacePath: "/w" })).generation, 2);
  assert.deepEqual(
    frames.map((frame) => [frame.state, frame.runtimeIdentity.generation]),
    [
      ["available", 1],
      ["unavailable", 1],
      ["available", 2],
    ],
  );

  subscription.dispose();
  await dispose();
});
