/**
 * 待发送撤回错误必须跨真实 IPC 保留 `name`。
 *
 * 界面按错误名判定"从未提交到 CLI 的确定性撤回"（清理恢复账本、不出红色发送错误）；
 * 这条分类只能依赖线上错误载荷，不能依赖本地对象或错误文案。这里用真实
 * MessageChannel + ChannelServer/ChannelClient 走一遍序列化往返。
 */
import type { IChannel, IServerChannel } from "@zcode/rpc";
import { ChannelClient, ChannelServer, MessagePortProtocol } from "@zcode/rpc";
import {
  NEK_PENDING_INPUT_CANCELLED,
  isNekPendingInputCancelled,
} from "@zcode/shared/nek-protocol";
import { describe, expect, it } from "vitest";

function createPair(thrower: () => never) {
  const { port1, port2 } = new MessageChannel();
  const server = new ChannelServer<string>(new MessagePortProtocol(port2), "test");
  const channel: IServerChannel<string> = {
    call: async () => thrower(),
    listen: () => {
      throw new Error("listen is not part of this round trip");
    },
  };
  server.registerChannel("pendingInput", channel);
  const client = new ChannelClient(new MessagePortProtocol(port1));
  return {
    call: async (): Promise<unknown> =>
      await client
        .getChannel<IChannel>("pendingInput")
        .call("sendText")
        .then(
          () => null,
          (error: unknown) => error,
        ),
    dispose: () => {
      client.dispose();
      server.dispose();
    },
  };
}

describe("待发送撤回错误跨 IPC", () => {
  it("渲染侧按 name 辨识，原文与文案都保留", async () => {
    const pair = createPair(() => {
      const error = new Error("压缩已取消，消息没有发送；草稿已保留，可重试");
      error.name = NEK_PENDING_INPUT_CANCELLED;
      throw error;
    });
    try {
      const error = await pair.call();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe(NEK_PENDING_INPUT_CANCELLED);
      expect((error as Error).message).toContain("草稿已保留");
      expect(isNekPendingInputCancelled(error)).toBe(true);
    } finally {
      pair.dispose();
    }
  });

  it("普通发送错误保持 Error，不会被误判成确定性撤回", async () => {
    const pair = createPair(() => {
      throw new Error("nek command sendText is unavailable");
    });
    try {
      const error = await pair.call();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("Error");
      expect(isNekPendingInputCancelled(error)).toBe(false);
    } finally {
      pair.dispose();
    }
  });
});
