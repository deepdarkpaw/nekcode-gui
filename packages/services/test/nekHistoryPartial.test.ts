import assert from "node:assert/strict";
import test from "node:test";
import type { NekHistoryPage, NekSessionEntry } from "@zcode/shared/nek-protocol";
import { projectHistory } from "../src/nek-agent/projection/nekHistoryProjection.js";
import { fixtureHistory } from "./nekHistoryFixture.js";
import { entry } from "./nekSessionHarness.js";

test("HS2/HS3: huge omitted arguments/output retain tool identity and explicit refs without fabricated input or aborted work", () => {
  const call: NekSessionEntry = {
    ...entry,
    id: "call",
    parentId: entry.id,
    message: {
      role: "assistant",
      timestamp: 2,
      provider: "test",
      model: "test",
      api: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "original" } }],
    },
  };
  const result: NekSessionEntry = {
    ...entry,
    id: "result",
    parentId: call.id,
    message: {
      role: "toolResult",
      timestamp: 3,
      toolCallId: "t",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "original output" }],
    },
  };
  const source = fixtureHistory([entry, call, result], {
    type: "read_history_page",
  }) as NekHistoryPage;
  source.entries[1] = {
    ...source.entries[1]!,
    entry: {
      ...call,
      message: {
        ...call.message,
        content: [{ type: "toolCall", id: "t", name: "read", arguments: null }],
      },
    },
    omissions: [
      {
        pointer: "/message/content/0/arguments",
        ref: "args-ref",
        totalBytes: 90_000_000,
        mediaType: "application/json",
        encoding: "base64",
      },
    ],
  };
  source.entries[2] = {
    ...source.entries[2]!,
    entry: { ...result, message: { ...result.message, content: null } },
    omissions: [
      {
        pointer: "/message/content",
        ref: "output-ref",
        totalBytes: 90_000_000,
        mediaType: "application/json",
        encoding: "base64",
      },
    ],
  };
  const rows = projectHistory({ sessionId: "s1", turns: source.turns, entries: source.entries });
  const tools = rows.filter((row) => row.kind === "toolCall");
  assert.equal(tools.length, 1);
  assert.equal(
    tools[0]?.status,
    "success",
    "known execution status is not invented output completeness",
  );
  assert.equal(tools[0]?.input, undefined, "no fake empty arguments object");
  assert.deepEqual(
    tools[0]?.historyContent?.map((ref) => ref.ref),
    ["args-ref", "output-ref"],
  );
  assert.equal(rows.filter((row) => row.entityId?.startsWith("history-deferred:")).length, 0);
  assert.ok(
    call.type === "message" &&
      call.message.role === "assistant" &&
      call.message.content[0]?.type === "toolCall",
  );
  assert.deepEqual(call.message.content[0].arguments, { path: "original" });
  assert.ok(JSON.stringify(rows).length < 10_000);
});
