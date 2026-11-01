import assert from "node:assert/strict";
import test from "node:test";
import type { NekRpcSessionState, NekSessionEntry } from "@zcode/shared/nek-protocol";
import { projectSelectionEntry } from "../src/nek-agent/projection/nekSelectionMarkers.js";
import { projectEntries } from "../src/nek-agent/projection/nekEntryProjection.js";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

function model(id: string, modelId = "first"): Extract<NekSessionEntry, { type: "model_change" }> {
  return {
    type: "model_change",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    provider: "mock",
    modelId,
  };
}
function thought(
  id: string,
  thinkingLevel: "off" | "high",
): Extract<NekSessionEntry, { type: "thinking_level_change" }> {
  return {
    type: "thinking_level_change",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    thinkingLevel,
  };
}
function chain(entries: NekSessionEntry[]): NekSessionEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    parentId: index ? entries[index - 1]!.id : null,
  }));
}
const state: NekRpcSessionState = {
  sessionId: "selection-test",
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: false,
  messageCount: 0,
  pendingMessageCount: 0,
  model: {
    provider: "mock",
    id: "second",
    name: "second",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1",
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};

test("initial and repeated model/thinking facts do not manufacture model self-switches", () => {
  const initial = projectSelectionEntry({}, model("m1"));
  assert.equal(initial.marker?.type, "modelChange");
  assert.ok(initial.marker && !("fromModel" in initial.marker));
  assert.equal(projectSelectionEntry(initial.next, model("m2")).marker, undefined);
  assert.equal(
    projectSelectionEntry({ ...initial.next, thought: "" }, thought("t0", "off")).marker,
    undefined,
  );
  const thinking = projectSelectionEntry(initial.next, thought("t1", "off"));
  assert.equal(thinking.marker, undefined);
  assert.equal(projectSelectionEntry(thinking.next, thought("t2", "off")).marker, undefined);
  assert.deepEqual(projectSelectionEntry(thinking.next, thought("t3", "high")).marker, {
    type: "modelChange",
    fromProvider: "mock",
    fromModel: "first",
    toProvider: "mock",
    toModel: "first",
    toThought: "high",
  });
});

test("history reconstructs from prior entries, never from the final get_state model", () => {
  const entries = chain([
    model("m1"),
    thought("t1", "off"),
    model("m2"),
    thought("t2", "off"),
    model("m3", "second"),
    thought("t3", "high"),
  ]);
  const snapshot = projectEntries({ sessionId: state.sessionId, entries, state });
  const markers = snapshot.rows.filter((row) => row.kind === "timelineMarker");
  assert.equal(markers.length, 3);
  assert.equal(markers[0]?.marker.type, "modelChange");
  assert.ok(markers[0] && !("fromModel" in markers[0].marker));
  assert.deepEqual(markers[1]?.marker, {
    type: "modelChange",
    fromProvider: "mock",
    fromModel: "first",
    toProvider: "mock",
    toModel: "second",
    toThought: "off",
  });
  assert.equal(snapshot.config.model, "second");
  assert.equal(snapshot.config.thought, "high");
});

test("live entries and restored history retain the same actual changes", () => {
  const initialEntries = chain([model("m1"), thought("t1", "off")]);
  const projector = new NekConversationProjector({ sessionId: state.sessionId });
  try {
    projector.loadSnapshot({ entries: initialEntries });
    for (const entry of chain([
      ...initialEntries,
      model("m2"),
      thought("t2", "off"),
      thought("t3", "high"),
    ]).slice(2)) {
      projector.handleEvent({ type: "entry_appended", entry });
    }
    const rows = projector.snapshot().rows.window.filter((row) => row.kind === "timelineMarker");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.marker.type === "modelChange" && rows[1].marker.toThought, "high");
  } finally {
    projector.dispose();
  }
});
