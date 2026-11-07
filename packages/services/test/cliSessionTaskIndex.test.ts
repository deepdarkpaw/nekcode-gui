/**
 * CLI 建的会话进入侧栏：task index 必须收录 GUI 之外创建的 nek 会话并通知侧栏重读，
 * 且被动观察不能为这些会话拉起 nek 进程。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_AGENT_PROVIDER, type ZCodeWorkspaceEvent } from "@zcode/shared";
import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "../src/zcode-agent/zcodeAgent.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import {
  createWorkspaceSessionImporter,
  WORKSPACE_SESSION_IMPORT_MIN_INTERVAL_MS,
} from "../src/zcode-agent/workspaceSessionImporter.js";
import { harness, sessionId, target } from "./nekSessionHarness.js";

const laterCliSession: NekSessionSummary = {
  id: "cli-later",
  path: "/sessions/cli-later.jsonl",
  cwd: target.workspacePath,
  createdAt: "2026-01-02T00:00:00.000Z",
  modifiedAt: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  firstMessage: "created in the terminal",
  locked: false,
};

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function withIndex(
  run: (context: {
    h: ReturnType<typeof harness>;
    repo: TaskIndexRepo;
    extraSessions: NekSessionSummary[];
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "nek-cli-task-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const extraSessions: NekSessionSummary[] = [];
  const h = harness({ extraSessions });
  try {
    await run({ h, repo, extraSessions });
  } finally {
    await h.adapter.dispose();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function listedTaskIds(repo: TaskIndexRepo): Promise<string[]> {
  const rows = await repo.listTaskMetas({
    ...target,
    provider: ZCODE_AGENT_PROVIDER,
    pinned: false,
    archived: false,
  });
  return rows.map((row) => row.taskId).sort();
}

function taskCreatedCount(events: ZCodeWorkspaceEvent[]): number {
  return events.filter(
    (event) => event.type === "workspace_task_list_changed" && event.reason === "task_created",
  ).length;
}

test("importing the session directory indexes CLI sessions without starting nek", async () => {
  await withIndex(async ({ h, repo, extraSessions }) => {
    let clock = 1_000;
    const syncer = createZCodeTaskIndexSyncer({ agentService: h.adapter, taskIndexRepo: repo });
    const events: ZCodeWorkspaceEvent[] = [];
    syncer.onDynamicWorkspaceEvent(target)((event) => events.push(event));
    const importer = createWorkspaceSessionImporter({
      agentService: h.adapter,
      taskIndexRepo: repo,
      onRowsInserted: (workspace) =>
        syncer.emitWorkspaceTaskListChanged(workspace, undefined, "task_created"),
      now: () => clock,
    });
    try {
      assert.deepEqual(await importer.importWorkspaceSessions(target), {
        status: "imported",
        inserted: 1,
      });
      assert.deepEqual(await listedTaskIds(repo), [sessionId]);
      const [row] = await repo.listTaskMetas({ ...target, provider: ZCODE_AGENT_PROVIDER });
      assert.equal(row?.title, "saved prompt");
      assert.equal(row?.status, "completed");
      assert.equal(taskCreatedCount(events), 1, "new rows are announced once");
      assert.equal(h.sessions.length, 0, "reading the directory never starts a session process");

      // 刚导入过：直接返回，不重复扫目录。
      assert.deepEqual(await importer.importWorkspaceSessions(target), {
        status: "skipped",
        reason: "recent",
      });

      // GUI 运行期间终端里又建了一个会话：下一轮导入补进来，已有行不再广播。
      extraSessions.push(laterCliSession);
      clock += WORKSPACE_SESSION_IMPORT_MIN_INTERVAL_MS;
      assert.deepEqual(await importer.importWorkspaceSessions(target), {
        status: "imported",
        inserted: 1,
      });
      assert.deepEqual(await listedTaskIds(repo), [laterCliSession.id, sessionId].sort());
      assert.equal(taskCreatedCount(events), 2);

      clock += WORKSPACE_SESSION_IMPORT_MIN_INTERVAL_MS;
      assert.deepEqual(await importer.importWorkspaceSessions(target), {
        status: "imported",
        inserted: 0,
      });
      assert.equal(taskCreatedCount(events), 2, "no new rows, no broadcast");
      assert.equal(h.sessions.length, 0);
    } finally {
      syncer.disposeAll();
    }
  });
});

test("the task service exposes the import and announces new rows on the workspace stream", async () => {
  await withIndex(async ({ h, repo }) => {
    const syncer = createZCodeTaskIndexSyncer({ agentService: h.adapter, taskIndexRepo: repo });
    const service = createZCodeTaskServiceAdapter({
      zcodeAgentService: h.adapter,
      taskIndexRepo: repo,
      taskIndexSyncer: syncer,
    });
    const events: ZCodeWorkspaceEvent[] = [];
    service.onDynamicWorkspaceEvent(target)((event) => events.push(event));
    try {
      assert.deepEqual(await service.importAgentSessions(target), { inserted: 1 });
      assert.deepEqual(
        (await service.listTasks(target)).map((task) => task.taskId),
        [sessionId],
      );
      assert.equal(taskCreatedCount(events), 1);
    } finally {
      syncer.disposeAll();
    }
  });
});

test("the first sessions-index snapshot seeds CLI sessions and tells the sidebar to reload", async () => {
  await withIndex(async ({ h, repo, extraSessions }) => {
    const syncer = createZCodeTaskIndexSyncer({ agentService: h.adapter, taskIndexRepo: repo });
    const events: ZCodeWorkspaceEvent[] = [];
    syncer.onDynamicWorkspaceEvent(target)((event) => events.push(event));
    try {
      // 打开项目时草稿预热会挂一个会话进程，workspace runtime 随之可用，task index 开始摄入。
      await h.adapter.createNekSession(target);
      await waitFor(async () => (await listedTaskIds(repo)).includes(sessionId), "seeded row");
      await waitFor(() => taskCreatedCount(events) === 1, "task_created broadcast");
      const spawned = h.sessions.length;

      // External sessions are discovered by explicit catalog refresh/import, not incidental queue traffic.
      const subscription = await h.adapter.subscribeSessionsIndexV4(target);
      extraSessions.push(laterCliSession);
      h.sessions[0]?.emit({ type: "queue_update", steering: [], followUp: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await listedTaskIds(repo)).includes(laterCliSession.id), false);
      await h.adapter.resyncSessionsIndexV4({
        ...target,
        subscriptionId: subscription.ack.subscriptionId,
      });
      await waitFor(
        async () => (await listedTaskIds(repo)).includes(laterCliSession.id),
        "external session row",
      );
      await waitFor(() => taskCreatedCount(events) === 2, "second task_created broadcast");
      assert.equal(h.sessions.length, spawned, "external sessions are indexed without a process");
    } finally {
      syncer.disposeAll();
    }
  });
});

test("existing-only snapshot reads never restore a session that is not open", async () => {
  await withIndex(async ({ h }) => {
    await assert.rejects(
      h.adapter.readSession({ ...target, sessionId, runtimePolicy: "existing-only" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
    );
    assert.equal(h.sessions.length, 0);

    // 显式打开（默认策略）仍然恢复磁盘会话，之后 existing-only 读得到。
    await h.adapter.readSession({ ...target, sessionId });
    assert.equal(h.sessions.length, 1);
    const snapshot = await h.adapter.readSession({
      ...target,
      sessionId,
      runtimePolicy: "existing-only",
    });
    assert.equal(snapshot.session.sessionId, sessionId);
    assert.equal(h.sessions.length, 1);
  });
});
