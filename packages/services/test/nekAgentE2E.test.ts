import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { NekGuiInfo, NekStatusFrame, NekStatusFrameEvent } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";

const nekWorktree = process.env.NEK_RPC_WORKTREE;
const enabled = process.env.NEK_E2E === "1";
const skipReason = !nekWorktree
  ? "NEK_RPC_WORKTREE is not set; real nek E2E is skipped"
  : !enabled
    ? "set NEK_E2E=1 to run the real nek E2E"
    : false;

test(
  "real nek adapter E2E with a local OpenAI-compatible SSE mock",
  { skip: skipReason },
  async () => {
    assert.ok(nekWorktree);
    const agentDir = await mkdtemp(join(tmpdir(), "nek-gui-e2e-agent-"));
    const projectDir = await mkdtemp(join(tmpdir(), "nek-gui-e2e-project-"));
    const sessionDir = join(agentDir, "sessions");
    const cliPath = join(nekWorktree, "packages", "coding-agent", "dist", "bundle", "cli.js");
    let server: Server | undefined;
    let adapter: ReturnType<typeof createNekAgentServiceAdapter> | undefined;
    const previousAgentDir = process.env.NEK_CODING_AGENT_DIR;
    try {
      server = createMockOpenAiServer();
      await listen(server);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      await writeFile(
        join(agentDir, "models.json"),
        `${JSON.stringify({
          providers: {
            mock: {
              baseUrl,
              api: "openai-completions",
              apiKey: "test-key",
              models: [
                {
                  id: "mock-model",
                  name: "Local Mock Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        })}\n`,
      );
      await writeFile(
        join(agentDir, "settings.json"),
        `${JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model" })}\n`,
      );
      process.env.NEK_CODING_AGENT_DIR = agentDir;
      const guiInfo = {
        protocolVersion: 1,
        nekVersion: "e2e-source",
        piVersion: "e2e-source",
        node: { path: process.execPath, version: process.versions.node },
        launch: { args: [cliPath] },
        agentDir,
        sessionDir,
        platform: process.platform,
        arch: process.arch,
      } satisfies NekGuiInfo;
      adapter = createNekAgentServiceAdapter({
        guiInfo,
        cwd: projectDir,
        askProjectTrust: () => true,
      });
      const target = { workspacePath: projectDir };
      // nek status feed：必须在创建会话前订阅（打开会话时服务侧才补快照）。
      const statusFrames: NekStatusFrame[] = [];
      const statusSubscription = adapter.onDynamicNekStatusFrame(target)((frame) =>
        statusFrames.push(frame),
      );
      const created = await adapter.createNekSession({ workspacePath: projectDir });
      const frames: unknown[] = [];
      const frameSubscription = adapter.onDynamicConversationFrame(target)((frame) =>
        frames.push(frame),
      );
      await adapter.subscribeConversationV4({ ...target, sessionId: created.sessionId });
      await adapter.sendNekConversationCommandV4({
        target,
        envelope: {
          commandId: "e2e-prompt-1",
          clientId: "e2e",
          sessionId: created.sessionId,
          type: "sendText",
          payload: { text: "List the files in this workspace." },
          issuedAt: Date.now(),
        },
      });
      await waitFor(() => hasAssistantAndToolRows(frames), 60_000);
      await waitFor(() => hasStatusLifecycle(statusFrames, created.sessionId), 60_000);
      assertStatusFrames(statusFrames, created.sessionId);
      const stats = await adapter.getNekSessionStats({
        ...target,
        sessionId: created.sessionId,
      });
      assert.equal(stats.sessionId, created.sessionId);
      const summaries = await adapter.listNekSessions(target);
      assert.ok(summaries.some((summary) => summary.id === created.sessionId));
      await waitFor(
        () =>
          statusEvents(statusFrames, created.sessionId).some(
            (event) => event.type === "agent_settled",
          ),
        60_000,
      );
      const beforeResume = await adapter.readNekSession({
        ...target,
        sessionId: created.sessionId,
      });
      await adapter.closeNekSession({ ...target, sessionId: created.sessionId });
      await waitFor(() => statusFrames.some((frame) => frame.kind === "closed"), 10_000);
      const resumed = await adapter.resumeNekSession({
        workspacePath: projectDir,
        sessionPath:
          created.sessionPath ??
          summaries.find((summary) => summary.id === created.sessionId)?.path ??
          "",
      });
      assert.deepEqual(beforeResume.rows, resumed.conversation.rows);
      frameSubscription.dispose();
      statusSubscription.dispose();

      // A full application restart loses every in-memory binding. Open only by the disk id,
      // exactly like SessionDataLayer.subscribe does, without an explicit legacy resume call.
      await adapter.dispose();
      adapter = createNekAgentServiceAdapter({
        guiInfo,
        cwd: projectDir,
        askProjectTrust: () => true,
      });
      const reopenedFrames: unknown[] = [];
      const reopenedStatus: NekStatusFrame[] = [];
      adapter.onDynamicConversationFrame(target)((frame) => reopenedFrames.push(frame));
      adapter.onDynamicNekStatusFrame(target)((frame) => reopenedStatus.push(frame));
      assert.equal(adapter.resolveSessionKey(target, created.sessionId), undefined);
      await adapter.subscribeConversationV4({ ...target, sessionId: created.sessionId });
      const restored = await adapter.readNekSession({ ...target, sessionId: created.sessionId });
      const tool = restored.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolName === "ls",
      );
      assert.ok(tool?.kind === "toolCall");
      assert.deepEqual(tool.input, { path: "." });
      assert.equal(tool.inputText, JSON.stringify({ path: "." }, null, 2));
      assert.equal(tool.status, "success");
      assert.ok(
        restored.rows.window.some(
          (row) => row.kind === "assistantText" && row.text.includes("listing is complete"),
        ),
      );
      assert.ok(reopenedFrames.length > 0);
      await adapter.sendNekConversationCommandV4({
        target,
        envelope: {
          commandId: "e2e-after-restart",
          clientId: "e2e",
          sessionId: created.sessionId,
          type: "sendText",
          payload: { text: "Continue this saved session." },
          issuedAt: Date.now(),
        },
      });
      await waitFor(
        () =>
          statusEvents(reopenedStatus, created.sessionId).some(
            (event) => event.type === "agent_settled",
          ),
        60_000,
      );
      const continued = await adapter.readNekSession({ ...target, sessionId: created.sessionId });
      assert.ok(
        continued.rows.window.some(
          (row) => row.kind === "userInput" && row.text === "Continue this saved session.",
        ),
      );
    } finally {
      if (adapter) await adapter.dispose();
      if (server) await close(server);
      if (previousAgentDir === undefined) delete process.env.NEK_CODING_AGENT_DIR;
      else process.env.NEK_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  },
);

function createMockOpenAiServer(): Server {
  let requestCount = 0;
  return createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
        "cache-control": "no-cache",
      });
      const events = requestCount === 1 ? firstResponseEvents() : finalResponseEvents();
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
}

function firstResponseEvents(): unknown[] {
  return [
    {
      choices: [
        {
          delta: { role: "assistant", content: "I will inspect the workspace.\n" },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_ls",
                type: "function",
                function: { name: "ls", arguments: '{"path":"."}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function finalResponseEvents(): unknown[] {
  return [
    {
      choices: [
        {
          delta: { role: "assistant", content: "The workspace listing is complete." },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function hasAssistantAndToolRows(frames: readonly unknown[]): boolean {
  const rows = frames.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.frame)) return [];
    const frame = candidate.frame;
    if (!isRecord(frame.payload)) return [];
    if (frame.payload.kind === "snapshot" && isRecord(frame.payload.snapshot)) {
      return Array.isArray(frame.payload.snapshot.rows) ? frame.payload.snapshot.rows : [];
    }
    if (frame.payload.kind !== "deltas" || !Array.isArray(frame.payload.deltas)) return [];
    return frame.payload.deltas.flatMap((delta) => {
      if (!isRecord(delta) || !["row.appended", "row.upserted"].includes(String(delta.op)))
        return [];
      return isRecord(delta.row) ? [delta.row] : [];
    });
  });
  return (
    rows.some((row) => isRecord(row) && row.kind === "assistantText") &&
    rows.some((row) => isRecord(row) && row.kind === "toolCall")
  );
}

function statusEvents(frames: readonly NekStatusFrame[], sessionId: string): NekStatusFrameEvent[] {
  return frames.flatMap((frame) =>
    frame.kind === "event" && frame.sessionKey === sessionId ? [frame.event] : [],
  );
}

function hasStatusLifecycle(frames: readonly NekStatusFrame[], sessionId: string): boolean {
  const types = new Set(statusEvents(frames, sessionId).map((event) => event.type));
  return types.has("agent_start") && (types.has("message_end") || types.has("agent_settled"));
}

function assertStatusFrames(frames: readonly NekStatusFrame[], sessionId: string): void {
  const snapshot = frames.find(
    (frame) => frame.kind === "snapshot" && frame.sessionKey === sessionId,
  );
  assert.ok(snapshot, "real nek E2E did not publish a status snapshot");
  if (snapshot?.kind !== "snapshot") throw new Error("expected a status snapshot frame");
  assert.equal(snapshot.snapshot.sessionKey, sessionId);
  assert.ok(Array.isArray(snapshot.snapshot.state.todos));
  assert.equal(typeof snapshot.snapshot.stats.sessionId, "string");
  const types = statusEvents(frames, sessionId).map((event) => event.type);
  assert.ok(types.includes("agent_start"), `missing agent_start: ${types.join(",")}`);
  assert.ok(
    types.includes("agent_settled") || types.includes("message_end"),
    `missing run end event: ${types.join(",")}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`E2E condition did not become true within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
