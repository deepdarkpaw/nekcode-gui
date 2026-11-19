import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekHistoryStreamEvent,
  NekHistoryStreamOmission,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import {
  applyConversationDeltas,
  coalesceConversationDeltas,
  conversationTopicFrameSchema,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  NekHistoryStreamDecoder,
  LIVE_EVENT_BYTES,
} from "../src/nek-agent/nekHistoryStreamDecoder.js";
import {
  loadNekHistoryStream,
  NekHistoryStreamSession,
} from "../src/nek-agent/service/nekHistoryStreamSession.js";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import type { NekSessionRecord } from "../src/nek-agent/service/types.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import {
  createProcess,
  guiInfo,
  sessionId,
  sessionPath,
  harness,
  params,
  target,
} from "./nekSessionHarness.js";
import { HISTORY_PAGE_MAX_BYTES } from "../src/nek-agent/service/nekHistoryRpc.js";

const body: NekHistoryStreamOmission[] = [
  { pointer: "/message", resolution: "history", reason: "persisted_body" },
];
const omit = (
  pointer: string,
  reason: "persisted_body" | "redundant_delta" = "persisted_body",
): NekHistoryStreamOmission => ({ pointer, resolution: "history", reason });
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function stored(id: string, parentId: string | null, message: unknown): NekSessionEntry {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-01-01T00:00:00Z",
    message,
  } as NekSessionEntry;
}
const assistant = (content: unknown[] = [], extra = {}) => ({
  role: "assistant",
  content,
  timestamp: 1,
  provider: "mock",
  model: "mock",
  api: "openai-responses",
  stopReason: "stop",
  usage,
  ...extra,
});

function decoderHarness(timeout = 30000) {
  const events: unknown[] = [],
    previews: Array<{ preview: string; receivedBytes: number }> = [],
    errors: Error[] = [];
  const decoder = new NekHistoryStreamDecoder(
    {
      event: (e) => events.push(e),
      preview: (p) => previews.push(p),
      error: (e) => errors.push(e),
    },
    timeout,
  );
  let seq = 0;
  const frame = (value: Record<string, unknown>) =>
    decoder.accept({ version: 1, epoch: "e1", seq: ++seq, ...value } as NekHistoryStreamEvent);
  decoder.begin();
  frame({ type: "history_stream_reset", sessionId: "s" });
  decoder.confirm({ version: 1, epoch: "e1", maxEventBytes: LIVE_EVENT_BYTES });
  return { decoder, frame, events, previews, errors };
}

test("LR6: live deltas publish the actual revision needed by renderer history watermark fences", () => {
  const projector = new NekConversationProjector({ sessionId: "revision-proof" });
  let rendered = projector.snapshot();
  const detach = projector.subscribe((frame) => {
    rendered =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot
        : { ...applyConversationDeltas(rendered, frame.payload.deltas), seq: frame.toSeq };
  });
  try {
    projector.handleEvent({ type: "agent_start" });
    projector.flushNow();
    expectRevision();
    projector.handleEvent({ type: "agent_settled", outcome: "success" });
    projector.flushNow();
    expectRevision();
  } finally {
    detach();
    projector.dispose();
  }
  function expectRevision() {
    assert.equal(rendered.revision, projector.snapshot().revision);
    assert.equal(rendered.seq, projector.snapshot().seq);
  }
});

test("LS2: chunked normal UTF8 JSON is exact; malformed offset/base64/final/interleaving fails visibly", () => {
  const h = decoderHarness();
  const event = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "猫🌎" },
  };
  const bytes = Buffer.from(JSON.stringify(event));
  h.frame({
    type: "history_event_start",
    eventId: 1,
    eventType: "message_update",
    encoding: "json-utf8/base64",
    omissions: [],
  });
  for (let offset = 0; offset < bytes.length; offset += 3)
    h.frame({
      type: "history_event_chunk",
      eventId: 1,
      offset,
      data: bytes.subarray(offset, offset + 3).toString("base64"),
      final: false,
    });
  h.frame({
    type: "history_event_chunk",
    eventId: 1,
    offset: bytes.length,
    data: "",
    final: true,
    totalBytes: bytes.length,
  });
  assert.deepEqual((h.events.at(-1) as { event: unknown }).event, event);
  assert.equal(h.decoder.bufferedBytes, 0);
  h.decoder.dispose();
  for (const bad of [
    { type: "history_event_chunk", eventId: 1, offset: 1, data: "e30=", final: false },
    { type: "history_event_chunk", eventId: 1, offset: 0, data: "!!!!", final: false },
    { type: "history_event_chunk", eventId: 1, offset: 0, data: "", final: true, totalBytes: 1 },
    { type: "history_event", eventId: 2, event: { type: "agent_start" }, omissions: [] },
  ]) {
    const x = decoderHarness();
    x.frame({
      type: "history_event_start",
      eventId: 1,
      eventType: "message_update",
      encoding: "json-utf8/base64",
      omissions: [],
    });
    x.frame(bad);
    assert.equal(x.errors.length, 1);
    assert.equal(x.decoder.bufferedBytes, 0);
    x.decoder.dispose();
  }
});

test("LS2/LS7: huge single delta/tool result drains with fixed memory and explicit incomplete preview, never fake completion", () => {
  for (const eventType of ["message_update", "tool_execution_update", "extension_event"]) {
    const h = decoderHarness();
    h.frame({
      type: "history_event_start",
      eventId: 1,
      eventType,
      encoding: "json-utf8/base64",
      omissions: [],
    });
    const chunk = Buffer.alloc(49152, 120).toString("base64");
    let offset = 0;
    for (let i = 0; i < 1600; i++) {
      h.frame({ type: "history_event_chunk", eventId: 1, offset, data: chunk, final: false });
      offset += 49152;
      assert.ok(h.decoder.bufferedBytes <= LIVE_EVENT_BYTES);
    }
    h.frame({
      type: "history_event_chunk",
      eventId: 1,
      offset,
      data: "",
      final: true,
      totalBytes: offset,
    });
    assert.equal(h.previews[0]?.preview.length, 32768);
    assert.equal(h.previews[0]?.receivedBytes, offset);
    assert.match(h.errors[0]!.message, /TRANSIENT_LIMIT.*incomplete/);
    assert.equal(h.events.length, 1, "no fabricated semantic answer/result");
    assert.equal(h.decoder.bufferedBytes, 0);
    h.decoder.dispose();
  }
});

test("LS6/LS7: sequence gaps, reset, retired epoch and timed-out chunks require explicit bounded recovery", async () => {
  const h = decoderHarness();
  h.frame({
    type: "history_event",
    eventId: 1,
    event: { type: "agent_start" },
    omissions: [],
    seq: 3,
  });
  assert.match(h.errors[0]!.message, /SEQUENCE/);
  h.decoder.begin();
  h.decoder.accept({
    type: "history_stream_reset",
    version: 1,
    epoch: "e2",
    seq: 1,
    sessionId: "s",
  });
  h.decoder.confirm({ version: 1, epoch: "e2", maxEventBytes: LIVE_EVENT_BYTES });
  h.decoder.accept({
    type: "history_stream_reset",
    version: 1,
    epoch: "e1",
    seq: 1,
    sessionId: "s",
  });
  h.decoder.accept({
    type: "history_event",
    version: 1,
    epoch: "e1",
    seq: 2,
    eventId: 1,
    event: { type: "agent_settled" },
    omissions: [],
  });
  assert.equal(h.errors.length, 1);
  h.decoder.accept({
    type: "history_stream_reset",
    version: 1,
    epoch: "e3",
    seq: 1,
    sessionId: "s",
  });
  assert.match(h.errors.at(-1)!.message, /RESET/);
  h.decoder.dispose();
  const x = decoderHarness(5);
  x.frame({
    type: "history_event_start",
    eventId: 1,
    eventType: "agent_end",
    encoding: "json-utf8/base64",
    omissions: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.match(x.errors[0]!.message, /CHUNK_TIMEOUT/);
  x.decoder.dispose();
});

async function integration(initial: NekSessionEntry[] = [], wrongTargetView = false) {
  const entries = [...initial];
  const summary = { ...historySummary, id: sessionId, path: sessionPath };
  const transport = createProcess((command) => {
    const result = fixtureHistory(entries, command, summary);
    return wrongTargetView && command.type === "read_history_page" && command.view === "target"
      ? { ...(result as NekHistoryPage), view: "entries" }
      : result;
  });
  const projector = new NekConversationProjector({ sessionId, streamFlushIntervalMs: 100000 });
  const record: NekSessionRecord = {
    key: sessionPath,
    path: sessionPath,
    sessionId,
    cwd: "/project",
    phase: "idle",
    readonly: false,
    closing: false,
    process: transport.process,
    projector,
  };
  const routed: string[] = [];
  const stream = new NekHistoryStreamSession(record, transport.process, (event, project) => {
    routed.push(event.type);
    if (project) project();
    else projector.handleEvent(event);
  });
  record.historyStream = stream;
  const detach = transport.process.client.onAnyEvent((event) => stream.accept(event));
  await stream.negotiate();
  projector.loadHistory({
    page: fixtureHistory(entries, { type: "read_history_page" }, summary) as NekHistoryPage,
    metadata: fixtureHistory(
      entries,
      { type: "read_session_metadata" },
      summary,
    ) as NekHistoryMetadata,
  });
  stream.resume();
  const frames: ConversationTopicFrame[] = [];
  let rendered = projector.snapshot();
  projector.subscribe((frame) => {
    conversationTopicFrameSchema.parse(frame);
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 4 * 1024 * 1024);
    frames.push(frame);
    if (frame.payload.kind === "snapshot") rendered = frame.payload.snapshot;
    else if (frame.payload.kind === "deltas")
      rendered = { ...applyConversationDeltas(rendered, frame.payload.deltas), seq: frame.toSeq };
  });
  let seq = 1,
    eventId = 0;
  const wire = (value: Record<string, unknown>) =>
    transport.emit({ version: 1, epoch: "fixture:1", seq: ++seq, ...value });
  const event = (value: Record<string, unknown>, omissions: NekHistoryStreamOmission[] = []) =>
    wire({ type: "history_event", eventId: ++eventId, event: value, omissions });
  const append = async (entry: NekSessionEntry, duplicate = false) => {
    if (!duplicate) entries.push(entry);
    wire({
      type: "history_entry_appended",
      sessionPath,
      sessionId,
      entryId: entry.id,
      leafId: entries.at(-1)?.id ?? null,
      ref: { command: "read_history_page", sessionPath, aroundEntryId: entry.id },
    });
    await stream.drain();
  };
  const close = async () => {
    stream.dispose();
    detach();
    projector.dispose();
    await transport.process.dispose();
  };
  return {
    entries,
    transport,
    projector,
    record,
    stream,
    routed,
    frames,
    event,
    wire,
    append,
    rendered: () => rendered,
    close,
  };
}

test("LS1: writable negotiation precedes bootstrap; replies/UI/auth route without stream deadlock; old capability is update-required", async () => {
  const h = await integration();
  try {
    assert.equal(h.transport.commands[0]?.type, "set_history_stream");
    h.transport.emit({ type: "auth_event", event: "test" });
    h.transport.emit({ type: "extension_ui_cancel", id: "missing" });
    assert.ok(h.routed.includes("auth_event"));
    assert.ok(h.routed.includes("extension_ui_cancel"));
    assert.equal(h.stream.failed, false);
    const old = {
      ...h.transport.process,
      guiInfo: { ...guiInfo, capabilities: { historyPages: 2 as const } },
    };
    const record = { ...h.record, process: old };
    const stream = new NekHistoryStreamSession(record, old, () => {});
    await assert.rejects(stream.negotiate(), /UPDATE_REQUIRED.*historyStream/);
    stream.dispose();
  } finally {
    await h.close();
  }
});

test("HT2/LS3/LS4/LS8: target locators reconcile tool output and user images with complete-turn page budget reads", async () => {
  const h = await integration();
  try {
    h.event({ type: "agent_start" });
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    assert.equal(h.projector.rows.window.filter((r) => r.kind === "userInput").length, 0);
    await h.append(
      stored("u1", null, {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "same" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      }),
    );
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp: 1, provider: "mock", model: "mock" },
      },
      body,
    );
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
    });
    h.event(
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } },
      [omit("/assistantMessageEvent/content", "redundant_delta")],
    );
    h.event({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "t1",
        toolName: "read",
      },
    });
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"a"}' },
    });
    h.event(
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 } },
      [omit("/assistantMessageEvent/toolCall", "redundant_delta")],
    );
    await h.stream.drain();
    h.projector.flushNow();
    await h.append(
      stored(
        "a1",
        "u1",
        assistant([
          { type: "text", text: "answer" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        ]),
      ),
    );
    h.event({ type: "message_end", message: { ...assistant(), content: undefined } }, body);
    h.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, [omit("/args")]);
    h.event(
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "read",
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
      [omit("/args")],
    );
    await h.stream.drain();
    const tool = h.projector.rows.window.find((r) => r.kind === "toolCall");
    assert.ok(tool?.kind === "toolCall");
    assert.equal(tool.inputText, '{"path":"a"}');
    await h.append({
      type: "custom",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-01-01",
      customType: "test",
      data: { ok: true },
    } as NekSessionEntry);
    await h.append(
      stored("r1", "c1", {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        timestamp: 1,
        content: [{ type: "text", text: "full result" }],
        isError: false,
      }),
    );
    h.event(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read",
        result: { structuredContent: { count: 1 }, terminate: true },
        isError: false,
      },
      [omit("/result/content"), omit("/result/details")],
    );
    h.event({ type: "agent_settled", outcome: "success" });
    // Exact same text/timestamp is a distinct accepted source user, not an alias.
    await h.append(stored("u2", "r1", { role: "user", timestamp: 1, content: "same" }));
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp: 1, provider: "mock", model: "mock" },
      },
      body,
    );
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" },
    });
    await h.append(stored("a2", "u2", assistant([{ type: "text", text: "second" }])));
    h.event({ type: "message_end", message: { ...assistant(), content: undefined } }, body);
    h.event({ type: "agent_settled", outcome: "success" });
    await h.stream.drain();
    h.projector.flushNow();
    assert.equal(h.stream.failed, false, h.projector.snapshot().control.lastError?.message);
    const rows = h.projector.rows.window;
    assert.equal(rows.filter((r) => r.kind === "userInput").length, 2);
    assert.deepEqual(
      rows.filter((r) => r.kind === "assistantText").map((r) => r.text),
      ["answer", "second"],
    );
    const finalTool = rows.find((r) => r.kind === "toolCall");
    assert.ok(finalTool?.kind === "toolCall");
    assert.equal(
      finalTool.rowId,
      tool.rowId,
      "persisted tool output updates the existing live tool row",
    );
    assert.equal(finalTool.output?.text, "full result");
    const user = rows.find((row) => row.kind === "userInput" && row.entityId === "entry:u1:user");
    assert.equal(user?.kind === "userInput" && user.attachments?.length, 1);
    const targets = h.transport.commands.filter(
      (command) => command.type === "read_history_page" && command.aroundEntryId,
    );
    assert.ok(targets.length > 0);
    assert.ok(
      targets.every(
        (command) => command.view === "target" && command.maxBytes === HISTORY_PAGE_MAX_BYTES,
      ),
    );
    assert.ok(
      h.transport.commands
        .filter((command) => command.type === "read_history_page" && command.view === "summary")
        .every((command) => command.maxBytes === 1024 * 1024),
    );
    assert.deepEqual(finalTool.liveResult, { structuredContent: { count: 1 }, terminate: true });
    const reads = h.transport.commands.filter(
      (c) => c.type === "read_history_page" && c.aroundEntryId === "a2",
    ).length;
    await h.append(h.entries.at(-1)!, true);
    assert.equal(
      h.transport.commands.filter((c) => c.type === "read_history_page" && c.aroundEntryId === "a2")
        .length,
      reads,
    );
    assert.equal(h.frames.filter((f) => f.payload.kind === "snapshot").length, 1);
    assert.ok(
      h.frames.some(
        (f) => f.payload.kind === "deltas" && f.payload.deltas.some((d) => d.op === "rows.removed"),
      ),
    );
    assert.deepEqual(h.rendered().rows.window, rows);
    const first = h.frames[0]!.payload;
    assert.equal(first.kind, "snapshot");
    if (first.kind === "snapshot") {
      const deltas = h.frames.flatMap((frame) =>
        frame.payload.kind === "deltas" ? frame.payload.deltas : [],
      );
      assert.deepEqual(
        applyConversationDeltas(first.snapshot, coalesceConversationDeltas(deltas)).rows.window,
        rows,
      );
    }
  } finally {
    await h.close();
  }
});

test("HT2: a live locator rejects entries-view replies instead of treating them as target slices", async () => {
  const h = await integration(
    [stored("u1", null, { role: "user", timestamp: 1, content: "first" })],
    true,
  );
  try {
    await h.append(
      stored("a1", "u1", assistant([{ type: "text", text: "must not partially render" }])),
    );
    assert.equal(h.stream.failed, true);
    assert.match(h.projector.snapshot().control.lastError?.message ?? "", /target page/);
    assert.equal(
      h.projector.rows.window.some((row) => row.kind === "assistantText"),
      false,
    );
  } finally {
    await h.close();
  }
});

test("LS5/LS6/LS8: 130 rounds retain older loaded rows; metadata-only cursors refresh without snapshot-per-append", async () => {
  const initial = [stored("old", null, { role: "user", timestamp: 1, content: "older viewport" })];
  const h = await integration(initial);
  try {
    const oldRows = h.projector.rows.window.map((row) => row.rowId);
    for (let i = 0; i < 130; i++) {
      const entry = stored(`u${i}`, h.entries.at(-1)!.id, {
        role: "user",
        timestamp: 1,
        content: "same",
      });
      await h.append(entry);
      h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
      h.event({ type: "agent_settled", outcome: "success" });
      await h.stream.drain();
    }
    assert.equal(h.stream.failed, false, h.projector.snapshot().control.lastError?.message);
    const snapshot = h.projector.snapshot();
    assert.equal(snapshot.history?.totalTurns, 131);
    assert.equal(snapshot.history.turns.length, 20);
    assert.equal(snapshot.history.olderCursor, "111");
    assert.ok(oldRows.every((id) => snapshot.rows.window.some((row) => row.rowId === id)));
    assert.equal(h.frames.filter((f) => f.payload.kind === "snapshot").length, 1);
    assert.equal(h.rendered().history?.totalTurns, 131);
  } finally {
    await h.close();
  }
});

test("LS2/LS7: bounded pre-bootstrap backlog fails visibly while normal RPC replies stay live", async () => {
  const h = await integration();
  try {
    await h.stream.negotiate(); // Pause for an explicit bounded bootstrap.
    for (let i = 1; i <= 65; i++)
      h.transport.emit({
        type: "history_event",
        version: 1,
        epoch: "fixture:2",
        seq: i + 1,
        eventId: i,
        event: { type: "queue_update", steering: [], followUp: [] },
        omissions: [],
      });
    assert.equal(h.stream.failed, true);
    assert.match(h.projector.snapshot().control.lastError!.message, /QUEUE_LIMIT/);
    await h.transport.process.client.call({ type: "get_state" });
    assert.equal(h.transport.process.client.pendingCount, 0);
    assert.equal(h.transport.isDisposed(), false);
  } finally {
    await h.close();
  }
});

test("LS7: disconnect during an unfinished chunk is a visible retryable history error", async () => {
  const h = await integration();
  try {
    h.wire({
      type: "history_event_start",
      eventId: 1,
      eventType: "message_update",
      encoding: "json-utf8/base64",
      omissions: [],
    });
    h.wire({
      type: "history_event_chunk",
      eventId: 1,
      offset: 0,
      data: Buffer.from('{"type":').toString("base64"),
      final: false,
    });
    await h.transport.process.dispose();
    assert.equal(h.stream.failed, true);
    assert.match(h.projector.snapshot().control.lastError!.message, /DISCONNECTED/);
    assert.equal(h.projector.snapshot().control.lastError!.recoverable, true);
    assert.equal(h.transport.process.client.pendingCount, 0);
  } finally {
    await h.close();
  }
});

test("LS6/LCB2: locator publishes only its observed turn; future bodies and source proofs wait for the checkpoint", async () => {
  const h = await integration();
  try {
    const before = h.projector.snapshot().history!;
    h.entries.push(
      stored("u", null, { role: "user", timestamp: 1, content: "hello" }),
      stored("a", "u", assistant([{ type: "text", text: "future" }])),
    );
    h.wire({
      type: "history_entry_appended",
      sessionPath,
      sessionId,
      entryId: "u",
      leafId: "a",
      ref: { command: "read_history_page", sessionPath, aroundEntryId: "u" },
    });
    await h.stream.drain();
    assert.equal(h.projector.observedHistoryEntries, 1);
    assert.ok(
      !h.projector.rows.window.some((r) => r.kind === "assistantText" && r.text === "future"),
    );
    const observed = h.projector.snapshot().history!;
    assert.equal(observed.totalTurns, 1, "the consumed user locator owns one real turn");
    assert.equal(observed.branchRevision, before.branchRevision);
    assert.equal(observed.observationCursor, before.observationCursor);
    h.wire({
      type: "history_entry_appended",
      sessionPath,
      sessionId,
      entryId: "a",
      leafId: "a",
      ref: { command: "read_history_page", sessionPath, aroundEntryId: "a" },
    });
    await h.stream.drain();
    assert.equal(h.projector.snapshot().history!.totalTurns, 1);
    assert.equal(h.stream.failed, false);
  } finally {
    await h.close();
  }
});

test("LS6: a bounded reload during live locators never rewinds the observed source behind applied entries", async () => {
  const h = await integration([
    stored("u", null, { role: "user", timestamp: 1, content: "hello" }),
  ]);
  try {
    const summary = { ...historySummary, id: sessionId, path: sessionPath };
    const appended = (entry: NekSessionEntry) => {
      h.entries.push(entry);
      h.wire({
        type: "history_entry_appended",
        sessionPath,
        sessionId,
        entryId: entry.id,
        leafId: entry.id,
        ref: { command: "read_history_page", sessionPath, aroundEntryId: entry.id },
      });
    };
    // The reload reads its page, then an entry commits and its locator arrives before the page lands.
    await loadNekHistoryStream(h.record, async () => {
      const read = [...h.entries];
      appended(stored("a", "u", assistant([{ type: "text", text: "answer" }])));
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.projector.loadHistory({
        page: fixtureHistory(read, { type: "read_history_page" }, summary) as NekHistoryPage,
        metadata: fixtureHistory(
          read,
          { type: "read_session_metadata" },
          summary,
        ) as NekHistoryMetadata,
      });
    });
    appended(stored("u2", "a", { role: "user", timestamp: 2, content: "next" }));
    await h.stream.drain();
    assert.equal(h.stream.failed, false);
    assert.equal(h.projector.observedHistoryEntries, 3);
    assert.equal(h.projector.snapshot().control.lastError ?? null, null);
  } finally {
    await h.close();
  }
});

test("TC1: an approved plan can commit the execution input before the plan settles without moving live work", async () => {
  const h = await integration();
  const start = Date.now() - 250_000;
  const headers = () => h.rendered().rows.window.filter((row) => row.kind === "turnHeader");
  const flush = async () => {
    await h.stream.drain();
    h.projector.flushNow();
  };
  const userStart = (timestamp: number) =>
    h.event({ type: "message_start", message: { role: "user", timestamp } }, body);
  const assistantStart = () =>
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp: start + 1_000, provider: "mock", model: "mock" },
      },
      body,
    );
  try {
    await h.append(
      stored("plan", null, { role: "user", timestamp: start - 10_000, content: "make plan" }),
    );
    h.event({ type: "agent_start" });
    userStart(start - 10_000);
    await flush();
    // The approval hook calls sendUserMessage inside agent_settled, before RPC delivers that event.
    await h.append(
      stored("execute", "plan", { role: "user", timestamp: start, content: "implement" }),
    );
    assert.equal(headers().find((row) => row.turnId === "turn:plan")?.state, "running");
    h.event({ type: "agent_settled", outcome: "completed" });
    h.event({ type: "agent_start" });
    userStart(start);
    assistantStart();
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "inspect" },
    });
    h.event({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        id: "read",
        toolName: "read",
        contentIndex: 1,
      },
    });
    await flush();
    const checkWork = () => {
      const rows = h.rendered().rows.window;
      assert.deepEqual(
        headers().map((row) => row.turnId),
        ["turn:plan", "turn:execute"],
      );
      assert.equal(headers()[0]!.state, "completedSuccess");
      const active = headers()[1]!;
      assert.equal(active.state, "running");
      assert.equal(active.startedAt, start);
      assert.equal(active.endedAt, undefined);
      const work = rows.filter((row) => row.kind === "reasoning" || row.kind === "toolCall");
      assert.equal(work.length, 2);
      assert.ok(work.every((row) => row.turnId === active.turnId));
      return active.rowId;
    };
    const headerId = checkWork();
    await h.append(
      stored(
        "response",
        "execute",
        assistant(
          [
            { type: "thinking", thinking: "inspect" },
            { type: "toolCall", id: "read", name: "read", arguments: { path: "config.rs" } },
          ],
          { timestamp: start + 1_000, stopReason: "toolUse" },
        ),
      ),
    );
    assert.equal(checkWork(), headerId);
    await h.append(
      stored("result", "response", {
        role: "toolResult",
        toolCallId: "read",
        toolName: "read",
        timestamp: Date.now(),
        content: [],
        isError: false,
      }),
    );
    assert.equal(checkWork(), headerId);
    h.event({ type: "agent_settled", outcome: "completed" });
    await flush();
    const end = headers()[1]!;
    assert.equal(end.rowId, headerId);
    assert.equal(end.state, "completedSuccess");
    assert.ok(end.endedAt! - end.startedAt >= 250_000);
    assert.equal(h.stream.failed, false);
    assert.deepEqual(h.rendered().rows.window, h.projector.rows.window);
  } finally {
    await h.close();
  }
});

test("TC2: consumed steer before its locator cuts the old turn once even with identical user timestamps", async () => {
  const h = await integration();
  const timestamp = Date.now() - 2000;
  const user = { role: "user", timestamp, content: "same input" };
  const start = () =>
    h.event({ type: "message_start", message: { role: "user", timestamp } }, body);
  try {
    await h.append(stored("first", null, user));
    start();
    start(); // Actual consumed steer; no settle event in between.
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp, model: "mock", provider: "mock" },
      },
      body,
    );
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "new work" },
    });
    await h.stream.drain();
    const before = h.projector.rows.window.filter((row) => row.kind === "turnHeader");
    assert.deepEqual(
      before.map((row) => row.state),
      ["completedSuccess", "running"],
    );
    const oldEnd = before[0]!.endedAt;
    await h.append(stored("second", "first", user));
    await h.append(stored("second", "first", user), true);
    const after = h.projector.rows.window.filter((row) => row.kind === "turnHeader");
    assert.deepEqual(
      after.map((row) => [row.turnId, row.state]),
      [
        ["turn:first", "completedSuccess"],
        ["turn:second", "running"],
      ],
    );
    assert.equal(after[0]!.endedAt, oldEnd);
    assert.equal(after[1]!.startedAt, before[1]!.startedAt);
    assert.equal(
      h.projector.rows.window.find((row) => row.kind === "reasoning")?.turnId,
      "turn:second",
    );
    assert.equal(h.stream.failed, false);
    assert.deepEqual(h.rendered().rows.window, h.projector.rows.window);
  } finally {
    await h.close();
  }
});

test("LS4/LS8: producer commits before queued text tokens; canonical aliases exist even before ephemeral rows", async () => {
  const h = await integration();
  try {
    await h.append(stored("u", null, { role: "user", timestamp: 1, content: "hello" }));
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp: 1, provider: "mock", model: "mock" },
      },
      body,
    );
    await h.append(stored("a", "u", assistant([{ type: "text", text: "ahead" }])));
    h.event({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ahead" },
    });
    h.event({ type: "message_end", message: { ...assistant(), content: undefined } }, body);
    await h.stream.drain();
    h.projector.flushNow();
    assert.equal(h.stream.failed, false);
    const texts = h.projector.rows.window.filter((r) => r.kind === "assistantText");
    assert.equal(texts.length, 1);
    assert.equal(texts[0]!.text, "ahead");
    assert.equal(texts[0]!.entityId, "entry:a:text:0");
    assert.deepEqual(h.rendered().rows.window, h.projector.rows.window);
  } finally {
    await h.close();
  }
});

for (const background of [true, false])
  test(`SA1/SA2: ${background ? "background" : "foreground"} child progress precedes its persisted spawn without poisoning history`, async () => {
    const h = await integration();
    try {
      await h.append(stored("u", null, { role: "user", timestamp: 1, content: "delegate" }));
      h.event({ type: "agent_start" });
      h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
      await h.append(
        stored(
          "a",
          "u",
          assistant([
            {
              type: "toolCall",
              id: "spawn",
              name: "subagent",
              arguments: { description: "inspect" },
            },
          ]),
        ),
      );
      h.event({ type: "tool_execution_start", toolCallId: "spawn", toolName: "subagent" }, [
        omit("/args"),
      ]);
      const child = {
        id: "child",
        type: "explorer",
        description: "inspect",
        background,
        status: "running",
        startedAt: 2,
      };
      // Real producer order: registry add/progress is broadcast inside the tool, before it returns.
      for (const activity of [undefined, "reading source", "checking history"])
        h.event({ type: "extension_event", name: "nek.subagent", payload: { ...child, activity } });
      await h.stream.drain();
      assert.equal(h.stream.failed, false);
      assert.equal(h.projector.snapshot().control.lastError ?? null, null);
      assert.equal(
        h.projector.rows.window.filter((row) => row.kind === "subagent").length,
        0,
        "status-only updates cannot invent a source row or guess the latest parent tool",
      );
      const returned = background ? child : { ...child, status: "completed", endedAt: 3 };
      h.event(
        {
          type: "tool_execution_end",
          toolCallId: "spawn",
          toolName: "subagent",
          isError: false,
          result: {},
        },
        [omit("/result/content"), omit("/result/details")],
      );
      await h.append(
        stored("r", "a", {
          role: "toolResult",
          toolCallId: "spawn",
          toolName: "subagent",
          timestamp: 3,
          content: [],
          details: { subagent: returned },
          isError: false,
        }),
      );
      const spawn = h.projector.rows.window.find((row) => row.kind === "subagent")!;
      assert.ok(spawn?.kind === "subagent");
      assert.equal(spawn.parentToolCallId, "spawn");
      assert.equal(spawn.turnId, "turn:u");
      assert.equal(spawn.status, background ? "running" : "success");
      await h.append(stored("u2", "r", { role: "user", timestamp: 4, content: "continue" }));
      h.event({
        type: "extension_event",
        name: "nek.subagent",
        payload: { ...child, status: "completed", endedAt: 5 },
      });
      await h.append(stored("a2", "u2", assistant([{ type: "text", text: "still connected" }])));
      await h.stream.drain();
      h.projector.flushNow();
      const after = h.projector.rows.window.find((row) => row.kind === "subagent")!;
      assert.equal(after.rowId, spawn.rowId);
      assert.equal(after.turnId, spawn.turnId);
      assert.equal(after.status, "success");
      assert.equal(h.projector.snapshot().control.lastError ?? null, null);
      assert.equal(h.stream.active, true);
      assert.ok(
        h.projector.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "still connected",
        ),
      );
      assert.deepEqual(h.rendered().rows.window, h.projector.rows.window);
    } finally {
      await h.close();
    }
  });

test("SA3: concurrent children arriving in reverse order keep their original tool turn across an accepted input", async () => {
  const h = await integration();
  try {
    await h.append(stored("u", null, { role: "user", timestamp: 1, content: "delegate twice" }));
    await h.append(
      stored(
        "a",
        "u",
        assistant(
          ["one", "two"].map((id) => ({
            type: "toolCall",
            id,
            name: "subagent",
            arguments: { description: id },
          })),
        ),
      ),
    );
    const children = ["one", "two"].map((id) => ({
      id: `child-${id}`,
      type: "explorer",
      description: id,
      background: true,
      status: "running",
      startedAt: 2,
    }));
    for (const child of [...children].reverse())
      h.event({ type: "extension_event", name: "nek.subagent", payload: child });
    await h.append(stored("u2", "a", { role: "user", timestamp: 3, content: "new input" }));
    for (const child of [...children].reverse()) {
      await h.append(
        stored(`r-${child.id}`, h.entries.at(-1)!.id, {
          role: "toolResult",
          toolCallId: child.description,
          toolName: "subagent",
          timestamp: 4,
          content: [],
          details: { subagent: child },
          isError: false,
        }),
      );
    }
    await h.stream.drain();
    assert.equal(h.stream.failed, false, h.projector.snapshot().control.lastError?.message);
    assert.equal(h.projector.snapshot().control.lastError ?? null, null);
    const rows = h.projector.rows.window.filter((row) => row.kind === "subagent");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.turnId, "turn:u");
      assert.equal(row.parentToolCallId, row.childSessionId?.replace("child-", ""));
      assert.equal(row.status, "running");
    }
  } finally {
    await h.close();
  }
});

test("LS3/LS8: compaction marker and subagent identity keep original anchors through metadata-only ends", async () => {
  const h = await integration();
  try {
    await h.append(stored("u", null, { role: "user", timestamp: 1, content: "delegate" }));
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    await h.append(
      stored(
        "a",
        "u",
        assistant([
          {
            type: "toolCall",
            id: "spawn",
            name: "subagent",
            arguments: { description: "inspect" },
          },
        ]),
      ),
    );
    const child = {
      id: "child",
      type: "worker",
      description: "inspect",
      background: true,
      status: "running",
      startedAt: 1,
    };
    await h.append(
      stored("r", "a", {
        role: "toolResult",
        toolCallId: "spawn",
        toolName: "subagent",
        timestamp: 1,
        content: [],
        details: { subagent: child },
        isError: false,
      }),
    );
    const spawn = h.projector.rows.window.find((r) => r.kind === "subagent")!;
    await h.append(stored("u2", "r", { role: "user", timestamp: 1, content: "continue" }));
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    h.event({
      type: "extension_event",
      name: "nek.subagent",
      payload: { ...child, status: "completed" },
    });
    h.event({ type: "compaction_start", reason: "manual" });
    await h.stream.drain();
    await h.append({
      type: "compaction",
      id: "compact",
      parentId: "u2",
      timestamp: "2026-01-01",
      tokensBefore: 123,
      firstKeptEntryId: "u2",
      summary: "summary",
    } as NekSessionEntry);
    h.event({ type: "compaction_end", reason: "manual", aborted: false, willRetry: true }, [
      omit("/result"),
    ]);
    await h.stream.drain();
    assert.equal(h.stream.failed, false, h.projector.snapshot().control.lastError?.message);
    const current = h.projector.rows.window.find((r) => r.kind === "subagent")!;
    assert.equal(current.rowId, spawn.rowId);
    assert.equal(current.turnId, spawn.turnId);
    assert.equal(current.kind === "subagent" && current.parentToolCallId, "spawn");
    const compact = h.projector.rows.window.filter(
      (r) => r.kind === "timelineMarker" && r.marker.type === "compact",
    );
    assert.equal(compact.length, 1);
    assert.equal(compact[0]!.marker.type === "compact" && compact[0]!.marker.summaryRef, "compact");
    assert.ok(!h.projector.snapshot().control.activeWorks.some((work) => work.kind === "compact"));
  } finally {
    await h.close();
  }
});

test("LS7/LS8: explicit adapter resync renegotiates once and bounded refetches without sending model input", async () => {
  const h = harness();
  const detach = h.adapter.onDynamicConversationFrame(target)(() => {});
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0]!;
    session.emit({
      type: "history_stream_error",
      version: 1,
      epoch: "fixture:1",
      seq: 2,
      code: "STORAGE_ERROR",
      message: "retry history only",
    });
    const before = session.commands.length;
    await Promise.all(
      [1, 2].map(() =>
        h.adapter.resyncConversationV4({
          ...target,
          subscriptionId: subscription.ack.subscriptionId,
        }),
      ),
    );
    const recovery = session.commands.slice(before);
    assert.equal(recovery.filter((c) => c.type === "set_history_stream").length, 1);
    assert.ok(recovery.some((c) => c.type === "read_history_page"));
    assert.ok(
      !recovery.some((c) =>
        ["prompt", "steer", "follow_up", "abort", "get_entries", "get_messages"].includes(c.type),
      ),
    );
  } finally {
    detach.dispose();
    await h.adapter.dispose();
  }
});

test("LS7: semantic-loss recovery during live work is explicitly deferred, never aliases a missing response or aborts it", async () => {
  let active = false;
  const h = harness({
    historyOverride: (command) =>
      command.type === "get_state" && active
        ? { sessionId, sessionFile: sessionPath, isStreaming: true, isCompacting: false }
        : undefined,
  });
  const detach = h.adapter.onDynamicConversationFrame(target)(() => {});
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    active = true;
    const session = h.sessions[0]!;
    session.emit({
      type: "history_stream_error",
      version: 1,
      epoch: "fixture:1",
      seq: 2,
      code: "ENCODING_ERROR",
      message: "lost transient semantics",
    });
    const input = { ...target, subscriptionId: subscription.ack.subscriptionId };
    await assert.rejects(h.adapter.resyncConversationV4(input), /RECOVERY_ACTIVE/);
    assert.ok(
      !session.commands.some((c) => ["prompt", "abort", "steer", "follow_up"].includes(c.type)),
    );
    active = false;
    await h.adapter.resyncConversationV4(input);
    assert.equal(session.commands.filter((c) => c.type === "set_history_stream").length, 3);
  } finally {
    detach.dispose();
    await h.adapter.dispose();
  }
});

test("LS3/LS7/LS8: empty model404 is visible, failure clears backlog and explicit renegotiation does not prompt/abort", async () => {
  const h = await integration();
  try {
    await h.append(stored("u", null, { role: "user", timestamp: 1, content: "hello" }));
    h.event({ type: "message_start", message: { role: "user", timestamp: 1 } }, body);
    h.event(
      {
        type: "message_start",
        message: { role: "assistant", timestamp: 1, provider: "mock", model: "mock" },
      },
      body,
    );
    h.event(
      {
        type: "message_end",
        message: assistant([], { stopReason: "error", errorMessage: "HTTP404 NOT_FOUND" }),
      },
      body,
    );
    await h.append(
      stored("a", "u", assistant([], { stopReason: "error", errorMessage: "HTTP404 NOT_FOUND" })),
    );
    const markers = h.projector.rows.window.filter(
      (r) => r.kind === "timelineMarker" && r.marker.type === "modelError",
    );
    assert.equal(markers.length, 1);
    h.wire({ type: "history_stream_error", code: "STORAGE_ERROR", message: "write failed" });
    assert.equal(h.stream.failed, true);
    assert.match(h.projector.snapshot().control.lastError!.message, /STORAGE_ERROR/);
    await h.stream.negotiate();
    h.stream.resume();
    assert.equal(h.stream.failed, false);
    assert.equal(h.transport.commands.filter((c) => c.type === "set_history_stream").length, 2);
    assert.ok(
      !h.transport.commands.some((c) => ["prompt", "abort", "steer", "follow_up"].includes(c.type)),
    );
  } finally {
    await h.close();
  }
});
