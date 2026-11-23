/** Real CLI ordering regression. All model traffic is handled by an isolated loopback fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { NekGuiInfo, NekRpcEvent, NekStatusFrame } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";

const source = process.env.NEK_RPC_WORKTREE;
const enabled = process.env.NEK_E2E === "1" && Boolean(source);

for (const background of [false, true])
  test(
    `SA1/SA2 real nek: ${background ? "background" : "foreground"} child broadcasts before persisted spawn without breaking history`,
    { skip: enabled ? false : "set NEK_E2E=1 and NEK_RPC_WORKTREE", timeout: 120_000 },
    async () => {
      const root = resolve(process.env.NEK_E2E_TMP ?? ".tmp");
      await mkdir(root, { recursive: true });
      const dir = await mkdtemp(join(root, "child-history-e2e-"));
      const agentDir = join(dir, "agent"),
        cwd = join(dir, "project");
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await mkdir(cwd);
      const calls: string[] = [];
      const failures: string[] = [];
      const server = createServer(async (request, response) => {
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            assert.ok(Buffer.byteLength(body) <= 8 * 1024 * 1024, "mock request budget");
          }
          assert.equal(request.url, "/v1/chat/completions");
          const { model, messages } = JSON.parse(body) as {
            model: string;
            messages: Array<{ role: string; content: unknown }>;
          };
          const lastUser = JSON.stringify(messages.findLast((m) => m.role === "user")?.content);
          const child = model === "child-fixture";
          const delegate =
            !child &&
            !lastUser.includes("CONTINUE_ONLY") &&
            !messages.some((m) => m.role === "tool");
          calls.push(child ? "child" : delegate ? "spawn" : "answer");
          if (child) await new Promise((done) => setTimeout(done, 200));
          const delta = delegate
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "spawn_fixture",
                    type: "function",
                    function: {
                      name: "subagent",
                      arguments: JSON.stringify({
                        description: "inspect fixture",
                        prompt: "CHILD_ONLY: answer briefly, no tools",
                        subagent_type: "fixture",
                        run_in_background: background,
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: child ? "Child completed." : "Parent continued." };
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          for (const part of [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" }] },
          ])
            response.write(`data: ${JSON.stringify(part)}\n\n`);
          response.end("data: [DONE]\n\n");
        } catch (error) {
          failures.push(String(error));
          response.writeHead(500);
          response.end("invalid local fixture request");
        }
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const previous = process.env.NEK_CODING_AGENT_DIR;
      let adapter: ReturnType<typeof createNekAgentServiceAdapter> | undefined;
      try {
        await writeFile(
          join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              mock: {
                api: "openai-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "fixture-only",
                models: ["fixture", "child-fixture"].map((id) => ({
                  id,
                  name: id,
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128000,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                })),
              },
            },
          }),
        );
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({
            defaultProvider: "mock",
            defaultModel: "fixture",
            defaultProjectTrust: "always",
            retry: { enabled: false },
            compaction: { enabled: false },
          }),
        );
        await writeFile(
          join(agentDir, "agents/fixture.md"),
          "---\nname: fixture\ndescription: Local regression fixture\nmodel: mock/child-fixture\ntools: []\n---\nReply briefly without using tools.\n",
        );
        process.env.NEK_CODING_AGENT_DIR = agentDir;
        const guiInfo: NekGuiInfo = {
          protocolVersion: 1,
          capabilities: { historyPages: 2, historyStream: 1 },
          nekVersion: "0.5.1-beta.6",
          piVersion: "1.0.2",
          node: { path: process.execPath, version: process.version },
          launch: {
            args: [
              "--import",
              pathToFileURL(
                join(source!, "packages/coding-agent/src/experimental/source-resolver.ts"),
              ).href,
              join(source!, "packages/coding-agent/src/cli.ts"),
            ],
          },
          agentDir,
          sessionDir: join(agentDir, "sessions"),
          platform: process.platform,
          arch: process.arch,
        };
        adapter = createNekAgentServiceAdapter({ guiInfo, cwd, askProjectTrust: () => "trust" });
        const target = { workspacePath: cwd };
        const status: NekStatusFrame[] = [];
        const subscription = adapter.onDynamicNekStatusFrame(target)((frame) => status.push(frame));
        const opened = await adapter.createNekSession(target);
        const key = adapter.resolveSessionKey(target, opened.sessionId)!;
        const events: NekRpcEvent[] = [];
        const detach = adapter.service.onEvent((event) => {
          if (event.type === "rpc_event" && event.session.sessionKey === key)
            events.push(event.event);
        });
        const snapshot = () => adapter!.service.conversationSnapshot(key);
        const wait = async (condition: () => boolean) => {
          const deadline = Date.now() + 30_000;
          while (!condition()) {
            assert.equal(snapshot().control.lastError ?? null, null);
            assert.ok(Date.now() < deadline, "local child regression must complete");
            await new Promise((done) => setTimeout(done, 20));
          }
        };
        try {
          await adapter.service.sendPrompt({
            sessionKey: key,
            message: "Delegate one fixture task.",
          });
          await wait(
            () =>
              events.some((event) => event.type === "agent_settled") &&
              snapshot().rows.window.some(
                (row) => row.kind === "subagent" && row.status === "success",
              ),
          );
          const progress = events.findIndex(
            (event) => event.type === "extension_event" && event.name === "nek.subagent",
          );
          const ended = events.findIndex(
            (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
          );
          assert.ok(
            progress >= 0 && progress < ended,
            "real first progress must precede metadata-only tool end",
          );
          const end = events[ended] as Extract<NekRpcEvent, { type: "tool_execution_end" }>;
          assert.equal(
            (end.result as { details?: unknown }).details,
            undefined,
            "historyStream omits tool details",
          );
          assert.ok(
            status.some(
              (frame) =>
                frame.kind === "event" &&
                frame.event.type === "extension_event" &&
                frame.event.name === "nek.subagent",
            ),
          );
          const spawn = snapshot().rows.window.find((row) => row.kind === "subagent")!;
          assert.equal(spawn.parentToolCallId, "spawn_fixture");
          const from = events.length;
          await adapter.service.sendPrompt({
            sessionKey: key,
            message: "CONTINUE_ONLY: answer briefly.",
          });
          await wait(() => events.slice(from).some((event) => event.type === "agent_settled"));
          assert.equal(snapshot().control.lastError ?? null, null);
          assert.ok(
            snapshot().rows.window.some(
              (row) => row.kind === "userInput" && row.text.startsWith("CONTINUE_ONLY"),
            ),
          );
          const after = snapshot().rows.window.find((row) => row.kind === "subagent")!;
          assert.equal(after.rowId, spawn.rowId);
          assert.equal(after.turnId, spawn.turnId);
          assert.deepEqual(failures, []);
          assert.ok(
            calls.includes("spawn") &&
              calls.includes("child") &&
              calls.filter((call) => call === "answer").length >= 2,
            `unexpected local request sequence: ${JSON.stringify(calls)}`,
          );
          await writeFile(
            join(dir, "result.json"),
            JSON.stringify(
              {
                background,
                calls,
                progress,
                ended,
                fault: snapshot().control.lastError ?? null,
                spawn: {
                  rowId: after.rowId,
                  turnId: after.turnId,
                  parentToolCallId: after.parentToolCallId,
                  status: after.status,
                },
              },
              null,
              2,
            ),
          );
        } finally {
          detach();
          subscription.dispose();
        }
      } finally {
        await adapter?.dispose();
        if (previous === undefined) delete process.env.NEK_CODING_AGENT_DIR;
        else process.env.NEK_CODING_AGENT_DIR = previous;
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
