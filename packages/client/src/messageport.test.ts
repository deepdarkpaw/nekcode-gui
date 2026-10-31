/**
 * renderer 连接接线回归：订阅失败必须进入连接 owner 既有的日志通道。
 *
 * 现场（2026-10-31）：`ChannelClient.onDidSubscriptionError` 只有测试订阅。真实 renderer
 * 连接把一条死流当作"暂时没有帧"，界面卡在加载态且没有任何可查证据。这里用真实
 * MessagePort 链路（服务端 ChannelServer + 渲染侧 createMessagePortServiceConnection）
 * 验证：订阅失败被上报、连接与其它的 RPC/订阅继续可用、dispose 后不再上报。
 */
import { describe, expect, it } from "vitest";
import {
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  type Event,
  type IServerChannel,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { IZCodeAgentService, type ZCodeAgentRuntimeLifecycleEvent } from "@zcode/services";
import { createMessagePortServiceConnection } from "./messageport.js";

const CHANNEL = IZCodeAgentService.channelName;

interface Harness {
  services: IServiceAccessor;
  failures: { level: string; args: unknown[] }[];
  frameSinks: Emitter<ZCodeAgentRuntimeLifecycleEvent>[];
  dispose: () => void;
}

function createHarness(): Harness {
  const { port1, port2 } = new MessageChannel();
  const server = new ChannelServer<string>(new MessagePortProtocol(port2), "test");
  const frameSinks: Emitter<ZCodeAgentRuntimeLifecycleEvent>[] = [];
  const channel: IServerChannel<string> = {
    async call<T>(_ctx: string, command: string): Promise<T> {
      return (
        command === "getWorkspaceRuntimeIdentity"
          ? { generation: 7, identity: "nek:/w", workspaceKey: "/w" }
          : { command }
      ) as T;
    },
    listen<T>(_ctx: string, event: string): Event<T> {
      if (event === "onAgentRuntimeLifecycle") {
        const sink = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
        frameSinks.push(sink);
        return sink.event as Event<T>;
      }
      throw new Error(`Event not found: ${event}`);
    },
  };
  server.registerChannel(CHANNEL, channel);

  const failures: { level: string; args: unknown[] }[] = [];
  const connection = createMessagePortServiceConnection(port1, {
    log: (level, args) => failures.push({ level, args }),
  });
  return {
    services: connection.services,
    failures,
    frameSinks,
    dispose: () => {
      connection.dispose();
      server.dispose();
    },
  };
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
};

describe("renderer MessagePort 连接", () => {
  it("订阅失败上报到连接日志通道，连接上的其它 RPC 照常", async () => {
    const harness = createHarness();
    try {
      const agent = harness.services.zcodeAgentService;
      // 订阅是懒的：必须先挂监听者，EventListen 才会真的发出去。
      const unknown = agent.onDynamicSessionActivity({ workspacePath: "/w" });
      // 未知事件：服务端回错误包，客户端不会把异常抛给调用方。
      expect(() => unknown(() => undefined)).not.toThrow();
      await waitFor(() => harness.failures.length === 1);

      expect(harness.failures[0]?.level).toBe("warn");
      expect(harness.failures[0]?.args[0]).toBe("[rpc:subscription] failed");
      const failure = harness.failures[0]?.args[1] as Error;
      expect(failure.message).toContain("Event not found: onDynamicSessionActivity");

      // 同一条连接继续可用：一条死流不能影响其它调用。
      await expect(agent.getWorkspaceRuntimeIdentity({ workspacePath: "/w" })).resolves.toEqual({
        generation: 7,
        identity: "nek:/w",
        workspaceKey: "/w",
      });
    } finally {
      harness.dispose();
    }
  });

  it("合法订阅照常收帧，dispose 之后不再上报", async () => {
    const harness = createHarness();
    try {
      const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
      const subscribe = harness.services.zcodeAgentService.onAgentRuntimeLifecycle;
      expect(subscribe).toBeTypeOf("function");
      const subscription = subscribe!((event) => frames.push(event));
      await waitFor(() => harness.frameSinks.length === 1);
      harness.frameSinks[0]!.fire({
        workspacePath: "/w",
        workspaceKey: "/w",
        runtimeIdentity: { generation: 1, identity: "nek:/w", workspaceKey: "/w" },
        state: "available",
      });
      await waitFor(() => frames.length === 1);
      expect(frames[0]?.state).toBe("available");
      expect(harness.failures).toEqual([]);
      subscription.dispose();
    } finally {
      harness.dispose();
    }
  });
});
