import assert from "node:assert/strict";
import test from "node:test";
import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "../src/conversation-share/conversationShareService.js";
import { ConversationShareHistoryReader } from "../src/conversation-share/conversationShareHistory.js";
import { ConversationShareHistoryError } from "../src/conversation-share/conversationShareHistoryPolicy.js";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import {
  exportedRows,
  historyFixture,
  quietLogger,
  target,
  turnId,
} from "./conversationShareHistoryFixture.js";

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((done) => setImmediate(done));
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const selection = { kind: "productTurns" as const, productTurnIds: [turnId(2)] };
const publishInput = {
  ...target,
  selection,
  title: "Bounded history",
  clientRequestId: "request-bounded",
};
const historyError = (code: string) => (error: unknown) =>
  error instanceof ConversationShareHistoryError && error.historyCode === code;

/** Canonical source IDs and sparse chronological row IDs survive complete-turn page reads. */
test("SH1/SH3: selected reverse-order turn IDs retain only the selected complete turns in source order", async () => {
  const h = historyFixture();
  const requested = {
    kind: "productTurns" as const,
    productTurnIds: [turnId(60), turnId(2), turnId(60)],
  };
  const before = JSON.stringify(h.rows);
  const read = await new ConversationShareHistoryReader().read(
    { ...target, selection: requested },
    h.agent,
    "source",
  );
  assert.deepEqual(
    read.rows.map((row) => row.rowId),
    [33, 34, 35, 961, 962, 963],
  );
  assert.deepEqual(
    [...read.turnOrdinals],
    [
      [turnId(2), 3],
      [turnId(60), 61],
    ],
  );
  assert.deepEqual(
    read.rows.filter((row) => row.kind === "turnHeader").map((row) => row.productTurnId),
    [turnId(2), turnId(60)],
  );
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every((call) => call.method === "page"));
  assert.equal(JSON.stringify(h.rows), before);
  const content = await exportedRows(h.service, requested);
  assert.deepEqual(
    content.rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    ["Question 3", "Question 61"],
  );
});

for (const field of [
  "atSeq",
  "atRevision",
  "atLogEpoch",
  "branchRevision",
  "totalTurns",
] as const) {
  test(`SH2/SH6: changed ${field} fences the export before a handle can be published`, async () => {
    const h = historyFixture();
    const original = h.agent.conversationHistoryPageV4;
    h.agent.conversationHistoryPageV4 = async (input) => {
      const page = await original(input);
      if (!input.beforeCursor) return page;
      if (field === "atSeq") return { ...page, atSeq: page.atSeq + 1 };
      if (field === "atRevision") return { ...page, atRevision: page.atRevision + 1 };
      if (field === "atLogEpoch") return { ...page, atLogEpoch: "replacement-epoch" };
      return {
        ...page,
        history: { ...page.history, [field]: field === "totalTurns" ? 71 : "replacement-branch" },
      };
    };
    const phases: string[] = [];
    const sub = h.service.onDynamicPublishProgress("fenced")((event) => phases.push(event.phase));
    try {
      await assert.rejects(
        h.service.publish({ ...publishInput, selection: { kind: "all" } }, "fenced"),
        historyError("history_stale"),
      );
      assert.deepEqual(phases, ["collecting"]);
    } finally {
      sub.dispose();
    }
  });
}

for (const mode of [
  "missing-cursor",
  "nondecreasing-page",
  "empty-page",
  "cursor-cycle",
  "false-complete",
  "failed-page",
] as const) {
  test(`SH2/SH6: ${mode} rejects visibly, never publishes a tail-only/partial archive`, async () => {
    const h = historyFixture();
    const original = h.agent.conversationHistoryPageV4;
    h.agent.conversationHistoryPageV4 = async (input) => {
      if (mode === "failed-page" && input.beforeCursor)
        throw new Error("Synthetic source page failure");
      const page = await original(
        input.beforeCursor === "stuck"
          ? { ...input, beforeCursor: "older:50" }
          : mode === "nondecreasing-page"
            ? { ...input, beforeCursor: undefined }
            : input,
      );
      if (mode === "missing-cursor")
        return { ...page, history: { ...page.history, olderCursor: undefined } };
      if (mode === "empty-page" && input.beforeCursor)
        return { ...page, rows: [], history: { ...page.history, turns: [] } };
      if (mode === "cursor-cycle")
        return { ...page, history: { ...page.history, olderCursor: "stuck" } };
      if (mode === "false-complete")
        return { ...page, history: { ...page.history, hasOlder: false, olderCursor: undefined } };
      return page;
    };
    await assert.rejects(
      exportedRows(h.service, { kind: "all" }),
      mode === "failed-page"
        ? /Synthetic source page failure/
        : historyError("history_invalid_page"),
    );
    assert.ok(h.calls.length <= 2);
  });
}

test("SH2/SH6: source row/selection/metadata limits reject before collecting unbounded arrays", async () => {
  const h = historyFixture();
  const original = h.agent.conversationHistoryPageV4;
  h.agent.conversationHistoryPageV4 = async (input) => {
    const page = await original(input);
    return {
      ...page,
      history: { ...page.history, totalTurns: CONVERSATION_ARCHIVE_LIMITS.rows + 1 },
    };
  };
  await assert.rejects(
    exportedRows(h.service, { kind: "all" }),
    historyError("history_budget_exceeded"),
  );
  const calls = h.calls.length;
  await assert.rejects(
    exportedRows(h.service, {
      kind: "productTurns",
      productTurnIds: Array.from({ length: CONVERSATION_ARCHIVE_LIMITS.rows + 1 }, () => turnId(2)),
    }),
    (error: unknown) => error instanceof Error && /bounded source turn/.test(error.message),
  );
  assert.equal(h.calls.length, calls, "oversized selection is refused before any source request");
});

test("SH2/SH6: an oversized source row batch rejects before it can enter the request-local collector", async () => {
  const h = historyFixture();
  const original = h.agent.conversationHistoryPageV4;
  h.agent.conversationHistoryPageV4 = async (input) => {
    const result = await original(input);
    return {
      ...result,
      rows: [
        result.rows[0]!,
        result.rows[1]!,
        ...Array.from({ length: CONVERSATION_ARCHIVE_LIMITS.rows - 1 }, (_, index) => ({
          ...result.rows[2]!,
          rowId: 40 + index,
          entityId: `oversized:${index}`,
        })),
      ],
    };
  };
  await assert.rejects(exportedRows(h.service, selection), historyError("history_budget_exceeded"));
  assert.equal(h.calls.length, 1);
});

test("SH2/SH3: missing canonical product identity or reordered source rows block instead of fabricating IDs/order", async () => {
  for (const mutation of ["missing-product", "reordered"] as const) {
    const h = historyFixture();
    const original = h.agent.conversationHistoryPageV4;
    h.agent.conversationHistoryPageV4 = async (input) => {
      const result = await original(input);
      return mutation === "missing-product"
        ? { ...result, rows: result.rows.map((row) => ({ ...row, productTurnId: undefined })) }
        : { ...result, rows: result.rows.toReversed() };
    };
    await assert.rejects(exportedRows(h.service, selection), historyError("history_invalid_page"));
  }
});

test("SH2/SH6: an oversized selected body blocks export and failed producers release their archive capacity", async () => {
  const h = historyFixture();
  const row = h.rows.find((row) => row.entityId === "entry:a3")!;
  assert.equal(row.kind, "assistantText");
  if (row.kind !== "assistantText") throw new Error("fixture");
  const previous = row.text;
  row.text = "x".repeat(CONVERSATION_ARCHIVE_LIMITS.manifestBytes + 1);
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(
      exportedRows(h.service, selection),
      historyError("history_budget_exceeded"),
    );
  row.text = previous;
  assert.equal((await exportedRows(h.service, selection)).rows.length, 3);
});

test("SH2/SH6: one read deadline covers earlier pages and a hanging later page; late completion cannot publish or advance", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = historyFixture();
  const blocked = gate();
  const original = h.agent.conversationHistoryPageV4;
  h.agent.conversationHistoryPageV4 = async (input) => {
    const page = await original(input);
    if (!input.beforeCursor)
      t.mock.timers.tick(DEFAULT_GUI_RUNTIME_CONFIG.timeouts.commandMs - 1000);
    else await blocked.promise;
    return page;
  };
  const phases: string[] = [];
  const sub = h.service.onDynamicPublishProgress("deadline")((event) => phases.push(event.phase));
  const failed = assert.rejects(
    h.service.publish({ ...publishInput, selection: { kind: "all" } }, "deadline"),
    historyError("history_timeout"),
  );
  try {
    await flush();
    assert.equal(h.calls.length, 2);
    t.mock.timers.tick(1000);
    await failed;
    blocked.resolve();
    await flush();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(phases, ["collecting"]);
  } finally {
    blocked.resolve();
    sub.dispose();
  }
});

test("SH2: bounded admission includes explicit preflights and is shared across connection facades", async () => {
  const h = historyFixture();
  const blocked = gate();
  const original = h.agent.conversationHistoryPageV4;
  h.agent.conversationHistoryPageV4 = async (input) => {
    const result = await original(input);
    await blocked.promise;
    return result;
  };
  const facade = h.service[conversationShareConnectionScopeFactory](h.agent);
  const a = h.service.preflight({ ...target, selection });
  const b = facade.preflight({ ...target, selection });
  try {
    await flush();
    await assert.rejects(
      facade.preflight({ ...target, selection }),
      (error: unknown) => error instanceof Error && /busy/.test(error.message),
    );
  } finally {
    blocked.resolve();
    await Promise.all([a, b]);
  }
});

test("SH2: preflight slots remain bounded while collected rows wait for artifact stat, not just during source paging", async () => {
  const h = historyFixture();
  const blocked = gate();
  const user = h.rows.find((row) => row.entityId === "entry:u3")!;
  Object.assign(user, {
    attachments: [{ ref: "private-image", fileName: "image.png", mime: "image/png", bytes: 1 }],
  });
  let stats = 0;
  h.agent.conversationAttachmentStatV4 = async () => {
    stats++;
    await blocked.promise;
    return { totalBytes: 1 };
  };
  const facade = h.service[conversationShareConnectionScopeFactory](h.agent);
  const a = h.service.preflight({ ...target, selection });
  const b = facade.preflight({ ...target, selection });
  try {
    await flush();
    assert.equal(stats, 2);
    await assert.rejects(h.service.preflight({ ...target, selection }), /busy/);
  } finally {
    blocked.resolve();
    await Promise.all([a, b]);
  }
});

test("SH3/SH5: public allow-list strips private history metadata/cursors/paths without rewriting selected tool JSON", () => {
  const h = historyFixture(1);
  const rows = structuredClone(h.rows);
  Object.assign(rows[0]!, {
    history: {
      branchRevision: "PRIVATE-branch",
      olderCursor: "PRIVATE-older",
      sessionPath: "file:///PRIVATE/session",
    },
  });
  const tool: ConversationRow = {
    ...rows[2]!,
    rowId: 4,
    entityId: "PRIVATE-tool-entity",
    kind: "toolCall",
    toolCallId: "PRIVATE-tool-call",
    toolName: "mock",
    status: "success",
    inputText: "safe request",
    input: {
      safe: "kept",
      history: { summaries: ["previous user content"] },
      cursor: "ordinary-tool-pagination-argument",
    },
    output: { text: "safe answer", truncated: { ref: "file:///PRIVATE/output", totalBytes: 10 } },
  };
  rows.push(tool);
  const original = JSON.stringify(rows);
  const projected = buildConversationSharePublicProjection({
    rows,
    selectedProductTurnIds: [turnId(0)],
  });
  assert.doesNotMatch(JSON.stringify(projected.rows), /PRIVATE|Cursor|branchRevision|sessionPath/);
  assert.equal(JSON.stringify(rows), original);
  const publicTool = projected.rows.find((row) => row.kind === "toolCall");
  assert.ok(publicTool?.kind === "toolCall");
  assert.deepEqual(publicTool.input, {
    safe: "kept",
    history: { summaries: ["previous user content"] },
    cursor: "ordinary-tool-pagination-argument",
  });
  const unsafe = structuredClone(h.rows);
  if (unsafe[2]!.kind === "assistantText") unsafe[2]!.text = "file:///outside";
  assert.throws(
    () =>
      buildConversationSharePublicProjection({ rows: unsafe, selectedProductTurnIds: [turnId(0)] }),
    /Local and inline URLs/,
  );
});

test("SH1/SH6: default production and attachment scope call the supplied source APIs directly, never optional-member probes or the unscoped agent", async () => {
  const h = historyFixture();
  const forbidden = new Proxy(h.agent, {
    get() {
      throw new Error("Unscoped source access forbidden");
    },
  });
  const host = new ConversationShareService({
    zcodeAgentService: forbidden,
    artifactSource: h.artifactSource,
    logger: quietLogger,
  });
  const methods: PropertyKey[] = [];
  const scopedAgent = new Proxy(h.agent, {
    get(object, method) {
      methods.push(method);
      const value = Reflect.get(object, method);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const facade = host[conversationShareConnectionScopeFactory](scopedAgent);
  const content = await exportedRows(facade, selection);
  assert.equal(content.rows.length, 3);
  assert.deepEqual(methods, Array(4).fill("conversationHistoryPageV4"));
  assert.deepEqual(h.calls[0]?.input, { ...target, turnLimit: 20 });
});

test("SH2/SH6: unsupported source RPC fails explicitly and never falls back through a ProxyChannel-shaped legacy member", async () => {
  const h = historyFixture();
  const methods: PropertyKey[] = [];
  const proxy = new Proxy(h.agent, {
    get(object, method) {
      methods.push(method);
      if (method === "conversationHistoryPageV4")
        return async () => {
          throw new Error("Unknown RPC command: conversationHistoryPageV4");
        };
      const value = Reflect.get(object, method);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const service = new ConversationShareService({
    zcodeAgentService: proxy,
    artifactSource: h.artifactSource,
    logger: quietLogger,
  });
  await assert.rejects(exportedRows(service, { kind: "all" }), /Unknown RPC command/);
  assert.deepEqual(methods, ["conversationHistoryPageV4"]);
  assert.equal(h.calls.length, 0);
});

test("SH1: row-only anchors require an explicit source turn identity, never a projection scan fallback", async () => {
  const h = historyFixture();
  await assert.rejects(
    h.service.preflight({ ...target, selection: { kind: "rowAnchors", rowIds: [34] } }),
    historyError("history_turn_selection_required"),
  );
  assert.equal(h.calls.length, 0);
});
