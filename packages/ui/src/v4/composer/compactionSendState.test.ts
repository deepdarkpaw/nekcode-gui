import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import { isCompactingInputRouting, resolveComposerSendLabelId } from "./compactionSendState.js";

describe("compactionSendState", () => {
  it("压缩中按 enqueue 路由报告，且发送键不能说成 CLI 队列", () => {
    const routing = { mode: "enqueue" as const, reasonCode: "compactingAcceptsFutureInput" };
    expect(isCompactingInputRouting(routing)).toBe(true);
    expect(resolveComposerSendLabelId(routing)).toBe("chat.composer.sendAfterCompaction");
  });

  it("运行中的 enqueue 仍是 CLI 队列语义", () => {
    const busy: InputRouting = { mode: "enqueue" };
    expect(resolveComposerSendLabelId(busy)).toBe("chat.queue.enqueue");
    expect(isCompactingInputRouting(busy)).toBe(false);
  });

  it("空闲与缺省快照保持普通发送文案", () => {
    expect(resolveComposerSendLabelId({ mode: "startNow" })).toBe("chat.send");
    expect(resolveComposerSendLabelId(null)).toBe("chat.send");
    expect(resolveComposerSendLabelId(undefined)).toBe("chat.send");
    expect(isCompactingInputRouting(null)).toBe(false);
  });
});
