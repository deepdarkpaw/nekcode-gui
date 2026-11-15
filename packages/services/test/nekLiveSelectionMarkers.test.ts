import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";

const stamp = "2026-11-15T00:00:00Z";
const model = (id: string, modelId: string): NekSessionEntry => ({
  id,
  parentId: null,
  type: "model_change",
  timestamp: stamp,
  provider: "mock",
  modelId,
});
const user = (id: string): NekSessionEntry => ({
  id,
  parentId: null,
  type: "message",
  timestamp: stamp,
  message: { role: "user", timestamp: 1, content: id },
});
const thought = (id: string, thinkingLevel: "off" | "high"): NekSessionEntry => ({
  id,
  parentId: null,
  type: "thinking_level_change",
  timestamp: stamp,
  thinkingLevel,
});
const chain = (entries: NekSessionEntry[]): NekSessionEntry[] =>
  entries.map((entry, index) => ({
    ...entry,
    parentId: index ? entries[index - 1]!.id : null,
  }));
const markers = (projector: NekConversationProjector) =>
  projector
    .snapshot()
    .rows.window.filter((row) => row.kind === "timelineMarker" && row.marker.type === "modelChange")
    .map((row) => (row.kind === "timelineMarker" ? row.marker : undefined));
function setup(initial: NekSessionEntry[]) {
  const entries = chain(initial);
  const projector = new NekConversationProjector({
    sessionId: historySummary.id,
    schedule: () => () => {},
  });
  const load = () =>
    projector.loadHistory({
      page: fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage,
      metadata: fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata,
    });
  load();
  const append = (entry: NekSessionEntry) => {
    const stored = { ...entry, parentId: entries.at(-1)?.id ?? null };
    entries.push(stored);
    const page = fixtureHistory(entries, {
      type: "read_history_page",
      view: "target",
      aroundEntryId: stored.id,
    }) as NekHistoryPage;
    // Authoritative selection before this turn's header is not the selection before
    // every later target inside the same turn (A -> B -> A must retain both changes).
    if (page.turns[0]!.header.id !== "m0")
      page.seed = { model: { provider: "mock", modelId: "first" }, thinkingLevel: "off" };
    projector.applyHistoryTarget(page, stored.id);
    projector.flushNow();
    return page;
  };
  return { projector, append, load };
}

test("LCM1: same-model rebinding on every round does not repeat the initial using marker", () => {
  const h = setup([model("m0", "first"), thought("t0", "off"), user("u0")]);
  try {
    assert.equal(markers(h.projector).length, 1);
    for (let turn = 1; turn <= 5; turn++) {
      h.append(model(`m${turn}`, "first"));
      h.append(user(`u${turn}`));
    }
    assert.equal(markers(h.projector).length, 1);
    h.load();
    assert.equal(markers(h.projector).length, 1, "reopening must show the same history");
  } finally {
    h.projector.dispose();
  }
});

test("LCM2/LCM3: ordered target selection preserves A -> B -> A and real thinking changes within one turn", () => {
  const h = setup([model("m0", "first"), thought("t0", "off"), user("u0")]);
  try {
    // Runtime reads can already report B before the ordered persisted A -> B locator.
    h.projector.applySessionState({
      sessionId: historySummary.id,
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      autoCompactionEnabled: false,
      messageCount: 1,
      pendingMessageCount: 0,
      model: {
        provider: "mock",
        id: "second",
        name: "second",
        api: "openai-responses",
        baseUrl: "http://127.0.0.1",
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const next = h.append(model("m1", "second"));
    h.append(model("m2", "second"));
    h.append(thought("t1", "off"));
    h.append(thought("t2", "high"));
    h.append(thought("t3", "high"));
    h.append(model("m3", "first"));
    const changes = markers(h.projector);
    assert.deepEqual(changes.slice(1), [
      {
        type: "modelChange",
        fromProvider: "mock",
        fromModel: "first",
        toProvider: "mock",
        toModel: "second",
        toThought: "off",
      },
      {
        type: "modelChange",
        fromProvider: "mock",
        fromModel: "second",
        toProvider: "mock",
        toModel: "second",
        toThought: "high",
      },
      {
        type: "modelChange",
        fromProvider: "mock",
        fromModel: "second",
        toProvider: "mock",
        toModel: "first",
        toThought: "high",
      },
    ]);
    h.projector.applyHistoryTarget(next, "m1");
    h.projector.flushNow();
    assert.deepEqual(markers(h.projector), changes, "a duplicate target cannot rewind selection");
    h.load();
    assert.deepEqual(markers(h.projector), changes);
  } finally {
    h.projector.dispose();
  }
});
