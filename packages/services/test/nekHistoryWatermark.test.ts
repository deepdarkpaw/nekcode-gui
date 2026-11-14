import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { createNekHistoryMethods } from "../src/nek-agent/adapter/nekHistoryMethods.js";
import type { NekAgentServiceAdapterLegacyTarget } from "../src/nek-agent/adapter/nekAgentServiceAdapterLegacySupport.js";
import type { NekHistoryReadContext } from "../src/nek-agent/service/nekHistoryService.js";
import { fixtureHistory } from "./nekHistoryFixture.js";
import { entry } from "./nekSessionHarness.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("HS4: delayed page overlays only the captured emitted body, not unflushed text that a later delta will append", async () => {
  const projector = new NekConversationProjector({ sessionId: "s1", schedule: () => () => {} });
  const user: NekSessionEntry = {
    ...entry,
    id: "next-user",
    parentId: entry.id,
    message: { role: "user", timestamp: 9, content: "next" },
  };
  const assistant: NekSessionEntry = {
    ...entry,
    id: "answer",
    parentId: user.id,
    message: {
      role: "assistant",
      timestamp: 10,
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
    },
  };
  const entries = [entry, user, assistant];
  const gate = Promise.withResolvers<NekHistoryPage>();
  try {
    projector.loadHistory({
      page: fixtureHistory([entry], { type: "read_history_page" }) as NekHistoryPage,
      metadata: fixtureHistory([entry], { type: "read_session_metadata" }) as NekHistoryMetadata,
    });
    projector.handleEvent({ type: "message_start", message: user.message });
    projector.handleEvent({ type: "entry_appended", entry: user });
    projector.handleEvent({ type: "message_start", message: assistant.message });
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    projector.handleEvent({ type: "entry_appended", entry: assistant });
    projector.flushNow();
    const snapshot = projector.snapshot();
    const context = {
      projector,
      snapshot,
      observedEntries: entries.length,
      readonly: false,
      watermark: {
        atSeq: snapshot.seq,
        atRevision: snapshot.revision,
        atLogEpoch: snapshot.logEpoch,
      },
      read: async () => await gate.promise,
    } as unknown as NekHistoryReadContext;
    const owner = {
      ensureNekSessionBinding: async () => ({ sessionKey: "s1" }),
      service: {
        runHistoryRead: async (
          _key: string,
          _child: string | undefined,
          run: (value: NekHistoryReadContext) => Promise<unknown>,
        ) => await run(context),
      },
    } as unknown as NekAgentServiceAdapterLegacyTarget;
    const pending = createNekHistoryMethods(owner).conversationHistoryPageV4({
      workspacePath: "/workspace",
      sessionId: "s1",
    });
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
    });
    gate.resolve(fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage);
    const page = await pending;
    assert.equal(page.atSeq, snapshot.seq);
    assert.equal(page.rows.find((row) => row.kind === "assistantText")?.text, "hello");
    assert.equal(
      projector.snapshot().rows.window.find((row) => row.kind === "assistantText")?.text,
      "hello world",
    );
    projector.flushNow();
    assert.ok(projector.seqValue > page.atSeq);
  } finally {
    projector.dispose();
  }
});
