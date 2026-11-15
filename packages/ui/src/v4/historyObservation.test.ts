import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "./conversationProjectionStore.js";
import type { ConversationTransport } from "./transport.js";
import { observationSource } from "../nek/status/historyObservation.testFixtures.js";
import { childRow, deferred } from "../nek/status/subagentHistory.testFixtures.js";

vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
const owners: ConversationProjectionStore[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
});
async function setup() {
  const source = observationSource(70, "completed");
  const transport = {
    subscribe: vi.fn(async () => ({
      ack: { subscriptionId: "sub", logEpoch: "epoch", mode: "snapshot" },
    })),
    activate() {},
    unsubscribe: vi.fn(async () => {}),
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    historyPage: vi.fn<ConversationTransport["historyPage"]>((params) =>
      source.service.conversationHistoryPageV4({ ...params, workspacePath: "/trusted" }),
    ),
    historyDirectory: vi.fn<ConversationTransport["historyDirectory"]>((params) =>
      source.service.conversationHistoryDirectoryV4({ ...params, workspacePath: "/trusted" }),
    ),
  };
  const store = new ConversationProjectionStore(
    "conversation/parent",
    transport as unknown as ConversationTransport,
  );
  owners.push(store);
  await store.connect();
  const page = source.page({});
  const snapshot: ConversationSnapshot = {
    protocolVersion: 1,
    sessionId: "parent",
    logEpoch: "epoch",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "title", titleSource: "default" },
    config: {
      provider: "test",
      model: "test",
      thought: "off",
      thoughtLevels: ["off"],
      followupMode: "queue",
      mode: "agent",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: { window: page.rows, totalCount: page.rows.length, firstRowId: page.rows[0]!.rowId },
    history: page.history,
  };
  const sendSnapshot = (value: ConversationSnapshot) =>
    store.handleFrame(
      {
        subscriptionId: "sub",
        topic: "conversation/parent",
        fromSeq: 0,
        toSeq: value.seq,
        payload: { kind: "snapshot", snapshot: value },
      } as ConversationTopicFrame,
      { deliveryKind: "initial" },
    );
  sendSnapshot(snapshot);
  const deltas = (values: ConversationDelta[]) => {
    const seq = store.getState().snapshot!.seq;
    store.handleFrame({
      subscriptionId: "sub",
      topic: "conversation/parent",
      fromSeq: seq,
      toSeq: seq + 1,
      payload: { kind: "deltas", deltas: values },
    } as ConversationTopicFrame);
  };
  let next = 70;
  const append = () => {
    source.append();
    deltas([
      { op: "row.appended", row: childRow(next++) },
      { op: "state.updated", patch: { revision: source.watermark.atRevision + 1 } },
    ]);
    source.watermark.atSeq = store.getState().snapshot!.seq;
    source.watermark.atRevision = store.getState().snapshot!.revision;
  };
  return { store, source, transport, append, sendSnapshot };
}

it("HO5: main older/newer/around reads accept changed append revisions only after forwarding prior proof", async () => {
  const { store, transport, append } = await setup();
  const before = store.getState().snapshot!;
  const owner = store.getHistoryOwnerKey();
  append();
  await store.loadOlder();
  expect(transport.historyPage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: "parent",
      beforeCursor: "before:50",
      observationCursor: before.history!.observationCursor,
    }),
  );
  expect(store.getState().historyError).toBeNull();
  expect(store.getState().snapshot!.history!.branchRevision).not.toBe(
    before.history!.branchRevision,
  );
  expect(store.getHistoryOwnerKey()).toBe(owner);
  append();
  await store.loadAround("entry:30");
  const around = store.getState().snapshot!;
  append();
  await store.loadNewer();
  const after = store.getState().snapshot!;
  expect(transport.historyPage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      afterCursor: "after:40",
      observationCursor: around.history!.observationCursor,
    }),
  );
  expect(after.history!.branchRevision).not.toBe(around.history!.branchRevision);
  expect(store.getState().historyError).toBeNull();
  expect(after.control).toBe(before.control);
  expect(after.config).toBe(before.config);
  expect(after.usage).toBe(before.usage);
  expect(after.seq).toBe(4);
});

it("HO5: main directory reads retain source proof across further appends", async () => {
  const { store, append, transport } = await setup();
  const initial = store.getState().snapshot!.history!;
  append();
  await store.readHistoryDirectory({ query: "question", limit: 20 });
  expect(transport.historyDirectory).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: "parent", observationCursor: initial.observationCursor }),
  );
  expect(store.getState().historyError).toBeNull();
});

it("HO4/HO5: failed source proof keeps main data and exact retry; explicit latest resets without proof", async () => {
  const { store, source, transport } = await setup();
  const before = store.getState().snapshot!;
  source.rewrite();
  await store.loadOlder();
  expect(store.getState().snapshot).toBe(before);
  expect(store.getState().historyError).toContain("STALE_CURSOR");
  expect(transport.historyPage).toHaveBeenCalledTimes(1);
  await store.loadOlder();
  expect(transport.historyPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ observationCursor: before.history!.observationCursor }),
  );
  expect(store.getState().snapshot).toBe(before);
  await store.loadLatest();
  expect(transport.historyPage.mock.calls.at(-1)?.[0].observationCursor).toBeUndefined();
  expect(store.getState().historyError).toBeNull();
  expect(store.getState().snapshot!.history!.branchRevision).not.toBe(
    before.history!.branchRevision,
  );
});

it("HO5: a malicious changed hash without a captured proof never replaces the main reading window", async () => {
  const { store, append, transport, sendSnapshot } = await setup();
  const snapshot = store.getState().snapshot!;
  sendSnapshot({ ...snapshot, history: { ...snapshot.history!, observationCursor: undefined } });
  append();
  const before = store.getState().snapshot;
  await store.loadOlder();
  expect(transport.historyPage.mock.calls.at(-1)?.[0].observationCursor).toBeUndefined();
  expect(store.getState().snapshot).toBe(before);
  expect(store.getState().historyError).toContain("without observation proof");
});

it("HO5: guarded replies missing proof cannot overwrite main rows or metadata", async () => {
  const { store, source, transport, append } = await setup();
  append();
  const before = store.getState().snapshot;
  const page = source.page({ beforeCursor: "before:50" });
  transport.historyPage.mockResolvedValueOnce({
    ...page,
    history: { ...page.history, observationCursor: undefined },
  });
  await store.loadOlder();
  expect(store.getState().snapshot).toBe(before);
  expect(store.getState().historyError).toContain("omitted its observation proof");
});

it.each(["epoch", "seq", "revision"])(
  "HO5: compatible source proof cannot bypass main %s fencing",
  async (field) => {
    const { store, source, append } = await setup();
    append();
    const before = store.getState().snapshot;
    if (field === "epoch") source.watermark.atLogEpoch = "retired";
    if (field === "seq") source.watermark.atSeq = 0;
    if (field === "revision") source.watermark.atRevision = 0;
    await store.loadOlder();
    expect(store.getState().snapshot).toBe(before);
    expect(store.getState().historyError).toContain("stale owner");
  },
);

it("HO5: a valid delayed append proof is still discarded after a replacement snapshot", async () => {
  const { store, source, transport, sendSnapshot, append } = await setup();
  const pending = deferred<Awaited<ReturnType<ConversationTransport["historyPage"]>>>();
  transport.historyPage.mockImplementationOnce(() => pending.promise);
  const request = store.loadOlder();
  append();
  sendSnapshot(store.getState().snapshot!);
  const before = store.getState().snapshot;
  pending.resolve(source.page({ beforeCursor: "before:50" }));
  await request;
  expect(store.getState().snapshot).toBe(before);
});
