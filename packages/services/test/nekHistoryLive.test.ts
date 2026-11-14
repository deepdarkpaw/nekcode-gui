import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { historyRowId } from "../src/nek-agent/projection/nekHistoryProjection.js";
import {
  stripPrivateHistoryRow,
  stripPrivateHistorySnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { fixtureHistory } from "./nekHistoryFixture.js";
import { entry } from "./nekSessionHarness.js";

function projectorFor(entries: NekSessionEntry[] = [entry]) {
  const projector = new NekConversationProjector({ sessionId: "s1" });
  projector.loadHistory({
    page: fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage,
    metadata: fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata,
  });
  return projector;
}
const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("HS3/HS4: persisted user/assistant aliases retire ephemeral rows and streaming continues at canonical positions", () => {
  const projector = projectorFor();
  const user = {
    ...entry,
    id: "next",
    parentId: entry.id,
    message: { role: "user" as const, timestamp: 9, content: "next input" },
  };
  const assistant = {
    ...entry,
    id: "answer",
    parentId: user.id,
    message: {
      role: "assistant" as const,
      timestamp: 10,
      api: "test",
      provider: "test",
      model: "test",
      content: [{ type: "text" as const, text: "hello" }],
      stopReason: "stop" as const,
      usage,
    },
  };
  try {
    projector.handleEvent({ type: "message_start", message: user.message });
    projector.handleEvent({ type: "entry_appended", entry: user });
    let rows = projector.snapshot().rows.window;
    assert.equal(
      rows.filter((row) => row.kind === "userInput" && row.text === "next input").length,
      1,
    );
    assert.equal(rows.find((row) => row.entityId === "entry:next:user")?.rowId, historyRowId(1, 1));
    projector.handleEvent({ type: "message_start", message: assistant.message });
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    projector.handleEvent({ type: "entry_appended", entry: assistant });
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
    });
    projector.flushNow();
    rows = projector.snapshot().rows.window;
    const text = rows.filter((row) => row.kind === "assistantText");
    assert.equal(text.length, 1);
    assert.equal(text[0]?.text, "hello world");
    assert.equal(text[0]?.entityId, "entry:answer:text:0");
    assert.equal(text[0]?.rowId, historyRowId(2, 16));
    assert.equal(text[0]?.turnId, "turn:next");
    assert.equal(new Set(rows.map((row) => row.rowId)).size, rows.length);
    const persisted = [entry, user, assistant];
    projector.loadHistory({
      page: fixtureHistory(persisted, { type: "read_history_page" }) as NekHistoryPage,
      metadata: fixtureHistory(persisted, { type: "read_session_metadata" }) as NekHistoryMetadata,
      state: {
        sessionId: "s1",
        thinkingLevel: "medium",
        isStreaming: true,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        autoCompactionEnabled: true,
        messageCount: 3,
        pendingMessageCount: 0,
      },
    });
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" },
    });
    projector.handleEvent({
      type: "message_end",
      message: { ...assistant.message, content: [{ type: "text", text: "hello world!" }] },
    });
    projector.flushNow();
    const continued = projector
      .snapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    assert.equal(continued.length, 1);
    assert.equal(continued[0]?.text, "hello world!");
    assert.equal(continued[0]?.entityId, "entry:answer:text:0");
  } finally {
    projector.dispose();
  }
});

test("HS3: persisted user append before message_start preserves the canonical identity", () => {
  const projector = projectorFor();
  const user = {
    ...entry,
    id: "persist-first",
    parentId: entry.id,
    message: { role: "user" as const, timestamp: 88, content: "persisted first" },
  };
  try {
    projector.handleEvent({ type: "entry_appended", entry: user });
    projector.handleEvent({ type: "message_start", message: user.message });
    const snapshot = projector.snapshot();
    assert.equal(snapshot.control.lastError, null);
    const rows = snapshot.rows.window.filter(
      (row) => row.kind === "userInput" && row.text === user.message.content,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entityId, "entry:persist-first:user");
    assert.equal(rows[0]?.rowId, historyRowId(1, 1));
  } finally {
    projector.dispose();
  }
});

test("HS4: append-compatible rebuild keeps epoch, truncation rotates it", () => {
  const projector = projectorFor();
  try {
    const initial = projector.snapshot();
    const next = { ...entry, id: "next", parentId: entry.id };
    projector.loadHistory({
      page: fixtureHistory([entry, next], { type: "read_history_page" }) as NekHistoryPage,
      metadata: fixtureHistory([entry, next], {
        type: "read_session_metadata",
      }) as NekHistoryMetadata,
    });
    assert.equal(projector.snapshot().logEpoch, initial.logEpoch);
    const replacement = { ...entry, id: "replacement" };
    projector.loadHistory({
      page: fixtureHistory([replacement], { type: "read_history_page" }) as NekHistoryPage,
      metadata: fixtureHistory([replacement], {
        type: "read_session_metadata",
      }) as NekHistoryMetadata,
    });
    assert.notEqual(projector.snapshot().logEpoch, initial.logEpoch);
    assert.ok(projector.snapshot().seq > initial.seq);
  } finally {
    projector.dispose();
  }
});

test("HS4: independent projector generations never reuse the same epoch", () => {
  const first = projectorFor();
  const second = projectorFor();
  try {
    assert.notEqual(first.snapshot().logEpoch, second.snapshot().logEpoch);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("HS4: changed persisted bytes with the same leaf identity invalidate the old epoch", () => {
  const projector = projectorFor();
  try {
    const before = projector.snapshot();
    const changed = [{ ...entry, message: { ...entry.message, content: "replacement bytes" } }];
    const page = fixtureHistory(changed, { type: "read_history_page" }) as NekHistoryPage;
    const metadata = fixtureHistory(changed, {
      type: "read_session_metadata",
    }) as NekHistoryMetadata;
    page.branchRevision = metadata.branchRevision = "changed-prefix-fingerprint";
    assert.equal(projector.acceptsHistoryPage(page), false);
    projector.loadHistory({ page, metadata });
    assert.notEqual(projector.snapshot().logEpoch, before.logEpoch);
    assert.ok(
      projector
        .snapshot()
        .rows.window.some((row) => row.kind === "userInput" && row.text === "replacement bytes"),
    );
  } finally {
    projector.dispose();
  }
});

test("HS2: public-row helper removes private deferred read capabilities", () => {
  const projector = projectorFor();
  try {
    const source = projector.snapshot().rows.window[0]!;
    const row = {
      ...source,
      historyContent: [
        {
          pointer: "",
          ref: "secret-ref",
          totalBytes: 12,
          mediaType: "application/json",
          encoding: "base64" as const,
        },
      ],
    };
    assert.equal(JSON.stringify(stripPrivateHistoryRow(row)).includes("secret-ref"), false);
    assert.equal(row.historyContent[0]?.ref, "secret-ref");
    const safe = stripPrivateHistorySnapshot({
      ...projector.snapshot(),
      rows: { window: [row], firstRowId: row.rowId, totalCount: 1 },
    });
    assert.equal(safe.history, undefined);
    assert.equal(JSON.stringify(safe).includes("secret-ref"), false);
  } finally {
    projector.dispose();
  }
});
