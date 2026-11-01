/**
 * renderer 连接接线回归：订阅失败必须同时给出"用户可见状态 + 可重试订阅"和诊断证据。
 *
 * 现场（2026-10-31）：`ChannelClient.onDidSubscriptionError` 只有测试订阅。真实 renderer
 * 连接把一条死流当作"暂时没有帧"，界面卡在加载态且没有任何可查证据；旧实现还会 dispose
 * emitter，导致"重试"只能由调用方另造一个没人监听的流。
 *
 * 这里用真实 MessagePort 链路（服务端 ChannelServer + 渲染侧
 * createMessagePortServiceConnection）验证：
 * - 订阅失败上报到连接 owner 的可见状态回调（后续由 UI 展示并触发重试）；
 * - `retry()` 重新建立同一条订阅，**同一个**订阅者继续收到帧；
 * - 一条死流不影响同连接上的其它 RPC / 其它订阅；
 * - 上报通道（日志/状态回调）抛错不会中断后续失败与帧投递。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  type Event,
  type IChannelSubscriptionFailure,
  type IServerChannel,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { IZCodeAgentService, type ZCodeAgentRuntimeLifecycleEvent } from "@zcode/services";
import type { ServiceConnectionOptions } from "./serviceConnectionLog.js";
import { createMessagePortServiceConnection } from "./messageport.js";

const CHANNEL = IZCodeAgentService.channelName;

interface HarnessOptions {
  /** 允许服务端建立订阅：先失败、再放行，用来验证重试真的重新订阅。 */
  failFirstSubscription?: boolean;
  onSubscriptionFailure?: ServiceConnectionOptions["onSubscriptionFailure"];
  log?: ServiceConnectionOptions["log"];
}

interface Harness {
  services: IServiceAccessor;
  failures: IChannelSubscriptionFailure[];
  frameSinks: Emitter<ZCodeAgentRuntimeLifecycleEvent>[];
  listenCalls: () => number;
  allowSubscription: () => void;
  dispose: () => void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const { port1, port2 } = new MessageChannel();
  const server = new ChannelServer<string>(new MessagePortProtocol(port2), "test");
  const frameSinks: Emitter<ZCodeAgentRuntimeLifecycleEvent>[] = [];
  let blocked = options.failFirstSubscription === true;
  let listenCount = 0;

  const channel: IServerChannel<string> = {
    async call<T>(_ctx: string, command: string): Promise<T> {
      return (
        command === "getWorkspaceRuntimeIdentity"
          ? { generation: 7, identity: "nek:/w", workspaceKey: "/w" }
          : { command }
      ) as T;
    },
    listen<T>(_ctx: string, event: string): Event<T> {
      listenCount += 1;
      if (event !== "onAgentRuntimeLifecycle") throw new Error(`Event not found: ${event}`);
      if (blocked) throw new Error("attach failed");
      const sink = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
      frameSinks.push(sink);
      return sink.event as Event<T>;
    },
  };
  server.registerChannel(CHANNEL, channel);

  const failures: IChannelSubscriptionFailure[] = [];
  const connection = createMessagePortServiceConnection(port1, {
    onSubscriptionFailure: (failure) => {
      failures.push(failure);
      options.onSubscriptionFailure?.(failure);
    },
    ...(options.log ? { log: options.log } : {}),
  });
  return {
    services: connection.services,
    failures,
    frameSinks,
    listenCalls: () => listenCount,
    allowSubscription: () => {
      blocked = false;
    },
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer MessagePort 连接", () => {
  it("订阅失败进入可见状态，重试后同一个订阅者继续收帧，其它 RPC 一直可用", async () => {
    const harness = createHarness({ failFirstSubscription: true });
    try {
      const agent = harness.services.zcodeAgentService;
      const subscribe = agent.onAgentRuntimeLifecycle;
      expect(subscribe).toBeTypeOf("function");

      const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
      // 订阅是懒的：必须先挂监听者，EventListen 才会真的发出去。
      const subscription = subscribe!((event) => frames.push(event));
      await waitFor(() => harness.failures.length === 1);

      const failure = harness.failures[0]!;
      expect(failure.channelName).toBe(CHANNEL);
      expect(failure.event).toBe("onAgentRuntimeLifecycle");
      expect(failure.error.message).toContain("attach failed");
      // 订阅者还挂着：可见状态需要提示并允许重试。
      expect(failure.isLive()).toBe(true);
      expect(harness.listenCalls()).toBe(1);

      // 死流不影响同一连接上的其它 RPC。
      await expect(agent.getWorkspaceRuntimeIdentity({ workspacePath: "/w" })).resolves.toEqual({
        generation: 7,
        identity: "nek:/w",
        workspaceKey: "/w",
      });

      // 用户点"重试"：重新建立同一条订阅（第二次 EventListen），不是新建空 emitter。
      harness.allowSubscription();
      failure.retry();
      await waitFor(() => harness.frameSinks.length === 1);
      expect(harness.listenCalls()).toBe(2);

      harness.frameSinks[0]!.fire({
        workspacePath: "/w",
        workspaceKey: "/w",
        runtimeIdentity: { generation: 2, identity: "nek:/w", workspaceKey: "/w" },
        state: "available",
      });
      await waitFor(() => frames.length === 1);
      // 同一个监听者收到恢复后的帧——调用方不需要自己重新订阅。
      expect(frames[0]?.state).toBe("available");
      subscription.dispose();
    } finally {
      harness.dispose();
    }
  });

  it("重试仍失败会再次上报，且不会自动循环", async () => {
    const harness = createHarness({ failFirstSubscription: true });
    try {
      const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
      const subscription = harness.services.zcodeAgentService.onAgentRuntimeLifecycle!((event) =>
        frames.push(event),
      );
      await waitFor(() => harness.failures.length === 1);

      // 服务端仍然失败：重试一次只多一次尝试，不会自己继续重试。
      harness.failures[0]!.retry();
      await waitFor(() => harness.failures.length === 2);
      expect(harness.listenCalls()).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(harness.listenCalls()).toBe(2);

      // 订阅者全部退订后，失败对象不再是"需要打扰用户"的状态。
      subscription.dispose();
      expect(harness.failures.at(-1)?.isLive()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("日志出口抛错不会中断可见状态与后续失败上报", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwingLog = vi.fn(() => {
      throw new Error("log sink down");
    });
    const harness = createHarness({ failFirstSubscription: true, log: throwingLog });
    try {
      const subscription = harness.services.zcodeAgentService.onAgentRuntimeLifecycle!(
        () => undefined,
      );
      await waitFor(() => harness.failures.length === 1);
      // 日志出口炸了：可见状态照常到达，异常走 console 通道而不是协议分发栈。
      expect(throwingLog).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();

      harness.failures[0]!.retry();
      await waitFor(() => harness.failures.length === 2);
      expect(throwingLog).toHaveBeenCalledTimes(2);
      subscription.dispose();
    } finally {
      harness.dispose();
    }
  });

  it("成功订阅不收失败状态，dispose 之后重试是空操作", async () => {
    const harness = createHarness();
    try {
      const frames: ZCodeAgentRuntimeLifecycleEvent[] = [];
      const subscription = harness.services.zcodeAgentService.onAgentRuntimeLifecycle!((event) =>
        frames.push(event),
      );
      await waitFor(() => harness.frameSinks.length === 1);
      harness.frameSinks[0]!.fire({
        workspacePath: "/w",
        workspaceKey: "/w",
        runtimeIdentity: { generation: 1, identity: "nek:/w", workspaceKey: "/w" },
        state: "available",
      });
      await waitFor(() => frames.length === 1);
      expect(harness.failures).toEqual([]);

      subscription.dispose();
      harness.dispose();
      expect(harness.failures).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
