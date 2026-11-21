import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAssistantMessage,
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { projectHistory } from "../src/nek-agent/projection/nekHistoryProjection.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, target, command } from "./nekSessionHarness.js";

const plan = {
  name: "Plan",
  path: "G:/project/.nek/plans/feature.plan.md",
  revision: 2,
  overview: "Overview",
  todos: [],
};
const details = { plan, markdown: "# Plan\n\n- Do the work" };
const ts = entry.timestamp;
const assistant: NekAssistantMessage = {
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "test",
  content: [{ type: "toolCall", id: "create-plan", name: "create_plan", arguments: {} }],
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 2,
};
const response = {
  id: "assistant",
  parentId: entry.id,
  timestamp: ts,
  type: "message",
  message: assistant,
} satisfies NekSessionEntry;
const artifact = {
  id: "artifact",
  parentId: response.id,
  timestamp: ts,
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "create-plan",
    toolName: "create_plan",
    content: [{ type: "text", text: "Plan saved" }],
    details,
    isError: false,
    timestamp: 3,
  },
} satisfies NekSessionEntry;
const preview = {
  id: "preview-announced-on-next-input",
  parentId: artifact.id,
  timestamp: ts,
  type: "custom_message",
  customType: "nek.plan_preview",
  content: details.markdown,
  details,
  display: true,
} satisfies NekSessionEntry;
const readyState = {
  mode: "plan",
  activePlanPath: plan.path,
  plans: [{ ...plan, status: "ready" }],
  todos: [],
  subagents: [],
} as const;
const newUser = {
  ...entry,
  id: "next-user",
  parentId: preview.id,
  message: { ...entry.message, timestamp: 4, content: "Revise this plan" },
};

function latest(entries: NekSessionEntry[]): NekHistoryPage {
  return fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage;
}
function targetPage(entries: NekSessionEntry[], aroundEntryId: string): NekHistoryPage {
  return fixtureHistory(entries, {
    type: "read_history_page",
    view: "target",
    aroundEntryId,
  }) as NekHistoryPage;
}
function metadata(entries: NekSessionEntry[]): NekHistoryMetadata {
  return fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata;
}
function planRows(rows: ReturnType<typeof projectHistory>) {
  return rows.filter((row) => row.kind === "toolCall" && row.toolName === "nek.plan");
}

function projectRealPlanOrder(): NekConversationProjector {
  const p = new NekConversationProjector({ sessionId: "s1", schedule: () => () => undefined });
  const initial = [entry, response];
  p.loadHistory({ page: latest(initial), metadata: metadata(initial) });
  p.applyHistoryTarget(targetPage([...initial, artifact], artifact.id), artifact.id);
  // 真实 historyStream=1 不传计划正文，且 preview 的持久定位可能要下一次输入才出现。
  p.handleHistoryEvent(
    {
      type: "message_end",
      message: { role: "custom", customType: preview.customType, display: true, timestamp: 4 },
    },
    [{ pointer: "/message", reason: "persisted_body", resolution: "history" }],
    "live-preview",
  );
  return p;
}

test("the committed plan is visible from the live stream and resubscribe before nek announces the preview copy", () => {
  const p = projectRealPlanOrder();
  try {
    const live = planRows(p.rows.window);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.turnId, `turn:${entry.id}`);
    const detach = p.subscribe((frame) => {
      assert.equal(frame.payload.kind, "snapshot");
      if (frame.payload.kind === "snapshot")
        assert.deepEqual(planRows(frame.payload.snapshot.rows.window), live);
    });
    detach();
  } finally {
    p.dispose();
  }
});

test("the next input does not introduce a plan row from the old preview; live, page and reopen share one identity", () => {
  const p = projectRealPlanOrder();
  try {
    const before = planRows(p.rows.window);
    const entries = [entry, response, artifact, preview, newUser];
    p.applyHistoryTarget(targetPage(entries, preview.id), preview.id);
    p.applyHistoryTarget(targetPage(entries, newUser.id), newUser.id);
    assert.deepEqual(planRows(p.rows.window), before, "late preview must not append a plan row");
    const page = latest(entries);
    const paged = planRows(
      projectHistory({ sessionId: "s1", entries: page.entries, turns: page.turns }),
    );
    assert.deepEqual(paged, before);
    const reopened = new NekConversationProjector({ sessionId: "s1" });
    try {
      reopened.loadHistory({ page, metadata: metadata(entries) });
      assert.deepEqual(planRows(reopened.rows.window), before);
    } finally {
      reopened.dispose();
    }
  } finally {
    p.dispose();
  }
});

test("nek.state changes active plan eligibility without replacing the persisted card", () => {
  const p = projectRealPlanOrder();
  try {
    const before = planRows(p.rows.window);
    const report = (state: unknown) =>
      p.handleEvent({ type: "extension_event", name: "nek.state", payload: state });
    report(readyState);
    assert.deepEqual(p.snapshot().config.nekReadyPlan, {
      path: plan.path,
      revision: plan.revision,
    });
    for (const state of [
      { ...readyState, mode: "agent" },
      { ...readyState, activePlanPath: "/other.plan.md" },
      { ...readyState, plans: [{ ...plan, status: "draft" }] },
    ]) {
      report(state);
      assert.equal(p.snapshot().config.nekReadyPlan, undefined);
      assert.deepEqual(planRows(p.rows.window), before);
    }
  } finally {
    p.dispose();
  }
});

test("an earlier revision is rejected after reopening; the current ready revision uses nek's build command", async () => {
  const previewed = [entry, response, artifact, preview];
  let mode: "plan" | "agent" = "plan";
  let draft = false;
  const h = harness({
    entries: previewed,
    historyOverride: (request) => {
      if (request.type === "extension_call" && request.method === "nek.get_state") {
        return {
          result: { ...readyState, mode, plans: [{ ...plan, status: draft ? "draft" : "ready" }] },
        };
      }
      if (request.type === "prompt" && request.message === "/nek-build feature --revision 2") {
        mode = "agent";
        return { disposition: "handled" };
      }
    },
  });
  const execute = (revision: number) =>
    h.adapter.sendNekConversationCommandV4({
      target,
      envelope: {
        ...command,
        commandId: `execute-${revision}`,
        type: "executeNekPlan",
        payload: { path: plan.path, revision, fresh: false },
      },
    });
  try {
    // 没有早先的进程、审批和 renderer 草稿：只按磁盘会话 ID 恢复。
    await h.adapter.subscribeConversationV4(params);
    const previous = await h.adapter.readNekSession(params);
    assert.equal(previous.config.mode, "plan");
    assert.equal(planRows(previous.rows.window).length, 1);
    assert.deepEqual(previous.config.nekReadyPlan, { path: plan.path, revision: plan.revision });
    await assert.rejects(execute(1), /已不是当前可执行的计划/u);
    assert.ok(!h.sessions[0]!.commands.some((request) => request.type === "prompt"));
    await h.adapter.closeNekSession(params);
    await h.adapter.subscribeConversationV4(params);
    const paging = await h.adapter.conversationHistoryPageV4({ ...params, turnLimit: 1 });
    assert.deepEqual(planRows(paging.rows), planRows(previous.rows.window));
    // 按钮点击后的准入再读 nek；renderer 仍有旧 ready 快照也不能把 draft 发出去。
    draft = true;
    await assert.rejects(execute(2), /已不是当前可执行的计划/u);
    draft = false;
    assert.equal((await execute(2)).status, "accepted");
    assert.ok(
      h.sessions[1]!.commands.some(
        (request) =>
          request.type === "prompt" && request.message === "/nek-build feature --revision 2",
      ),
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("native fresh execution returns once the child input is durable, without rebinding the source snapshot", async () => {
  const child = { sessionId: "new-plan-session", sessionPath: "/sessions/new-plan.sqlite" };
  const childSummary = {
    ...historySummary,
    id: child.sessionId,
    path: child.sessionPath,
    cwd: target.workspacePath,
  };
  const seed = {
    id: "seed",
    parentId: null,
    type: "custom",
    customType: "nek.plan_snapshot",
    data: details,
    timestamp: ts,
  } satisfies NekSessionEntry;
  const implementation = {
    ...newUser,
    id: "execute",
    parentId: seed.id,
    message: { ...newUser.message, content: "Implement the plan" },
  };
  let switched = false;
  const h = harness({
    entries: [entry, response, artifact, preview],
    historyOverride: (request) => {
      if (request.type === "extension_call" && request.method === "nek.get_state")
        return { result: readyState };
      if (request.type === "read_history_page" && switched)
        return fixtureHistory([seed, implementation], request, childSummary);
      if (
        request.type === "prompt" &&
        request.message === "/nek-build feature --revision 2 --fresh"
      ) {
        const session = h.sessions[0]!;
        switched = true;
        session.replaceSession(child);
        session.append(seed.id, implementation.id);
        session.append(implementation.id, implementation.id);
        // nek 的原生命令不会在子会话模型回合结束前回答 prompt。
        return new Promise(() => undefined);
      }
    },
  });
  try {
    await h.adapter.subscribeConversationV4(params);
    const ack = await h.adapter.sendNekConversationCommandV4({
      target,
      envelope: {
        ...command,
        type: "executeNekPlan",
        payload: { path: plan.path, revision: 2, fresh: true },
      },
    });
    assert.deepEqual(ack.result, { type: "executeNekPlan", sessionId: child.sessionId });
    const [source, next] = await Promise.all([
      h.adapter.readNekSession(params),
      h.adapter.readNekSession({ ...target, sessionId: child.sessionId }),
    ]);
    assert.equal(source.sessionId, params.sessionId);
    assert.equal(next.sessionId, child.sessionId);
    assert.deepEqual(
      planRows(source.rows.window).map((row) => row.entityId),
      [`entry:${artifact.id}:plan`],
    );
    assert.deepEqual(
      planRows(next.rows.window).map((row) => row.entityId),
      [`entry:${seed.id}:plan`],
    );
    assert.ok(
      next.rows.window.some((row) => row.kind === "userInput" && row.text === "Implement the plan"),
    );
    assert.equal(
      h.sessions.length,
      1,
      "native replacement must keep the process that is executing the child",
    );
    await h.adapter.closeNekSession(params);
    assert.equal(h.sessions[0]?.isDisposed(), false, "closing the source must not kill the child");
    await h.adapter.closeNekSession({ ...target, sessionId: child.sessionId });
    assert.equal(h.sessions[0]?.isDisposed(), true);
  } finally {
    await h.adapter.dispose();
  }
});
