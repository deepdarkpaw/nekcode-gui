/** Exact Gemini empty-message 404 regression, using real nek and only a loopback gateway. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { NekGuiInfo, NekRpcEvent } from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { createNekRuntimeServices } from "../src/createNekRuntimeServices.js";
import { createLocalNekConfigHostExecutor } from "../src/nek-config-api/index.js";
import { spawnNekProcess } from "../src/nek-agent/nekProcessLauncher.js";
import { projectEntries } from "../src/nek-agent/projection/nekEntryProjection.js";

const source = process.env.NEK_RPC_WORKTREE;
const enabled = process.env.NEK_E2E === "1" && Boolean(source);
const failure = { error: { message: "", code: 404, status: "Not Found" } };
const visibleFailures = (rows: readonly ConversationRow[]) =>
  rows.filter(
    (row) => row.kind === "timelineMarker" && JSON.stringify(row.marker).includes("Not Found"),
  );

test(
  "real Gemini 404 stays visible live and after reopening; model URL override reaches the native route",
  { skip: enabled ? false : "set NEK_E2E=1 and NEK_RPC_WORKTREE", timeout: 120_000 },
  async () => {
    const root = resolve(process.env.NEK_E2E_TMP ?? ".tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "google-error-e2e-"));
    const agentDir = join(dir, "agent"),
      cwd = join(dir, "project");
    await mkdir(agentDir);
    await mkdir(cwd);
    const paths: string[] = [];
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Drain without retaining prompt/credentials. */
      }
      paths.push(request.url ?? "");
      if (!request.url?.startsWith("/v1beta/")) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify(failure));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Local Gemini fixture success." }] },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
          modelVersion: "gemini-4-carbon",
        })}\n\n`,
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          CPA: {
            baseUrl: `${base}/v1`,
            apiKey: "fixture-only",
            models: [
              {
                id: "gemini-4-carbon",
                api: "google-generative-ai",
                contextWindow: 800000,
                maxTokens: 120000,
                reasoning: true,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "CPA",
        defaultModel: "gemini-4-carbon",
        defaultProjectTrust: "always",
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    const previous = process.env.NEK_CODING_AGENT_DIR;
    process.env.NEK_CODING_AGENT_DIR = agentDir;
    const guiInfo: NekGuiInfo = {
      protocolVersion: 1,
      nekVersion: "0.5.0-beta.2",
      piVersion: "1.0.2",
      node: { path: process.execPath, version: process.version },
      launch: {
        args: [
          "--import",
          pathToFileURL(join(source!, "packages/coding-agent/src/experimental/source-resolver.ts"))
            .href,
          join(source!, "packages/coding-agent/src/cli.ts"),
        ],
      },
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      platform: process.platform,
      arch: process.arch,
    };
    const executor = createLocalNekConfigHostExecutor({ agentDir, home: dir });
    executor.spawnNek = async (args) => spawnNekProcess({ guiInfo, cwd, args: [...args] }).handle;
    const { configApi, agentService } = createNekRuntimeServices({
      config: { hosts: { executor: () => executor, listTargets: async () => [] } },
      agent: { guiInfo, cwd, askProjectTrust: () => true },
    });
    try {
      const opened = await agentService.service.createSession({ cwd });
      const key = opened.sessionKey;
      const events: NekRpcEvent[] = [];
      const detach = agentService.service.onEvent((event) => {
        if (event.type === "rpc_event" && event.session.sessionKey === key)
          events.push(event.event);
      });
      const send = async () => {
        const from = events.length;
        const ack = await agentService.service.sendPrompt({
          sessionKey: key,
          message: "Reply briefly. Do not use tools.",
        });
        assert.equal(
          ack.disposition,
          "started",
          "provider failure follows input acceptance, not SEND_FAILED",
        );
        const deadline = Date.now() + 30_000;
        while (!events.slice(from).some((event) => event.type === "agent_settled")) {
          assert.ok(Date.now() < deadline, "local mock turn must settle");
          await new Promise((done) => setTimeout(done, 20));
        }
      };
      try {
        await agentService.service.setModel({
          sessionKey: key,
          provider: "CPA",
          modelId: "gemini-4-carbon",
        });
        await send();
        const live = agentService.service.conversationSnapshot(key);
        assert.equal(
          visibleFailures(live.rows.window).length,
          1,
          "empty assistant error cannot disappear",
        );
        assert.ok(
          live.rows.window.some((row) => row.kind === "turnHeader" && row.state === "failed"),
        );
        const entries = await agentService.service.getEntries({ sessionKey: key });
        assert.equal(
          visibleFailures(projectEntries({ sessionId: opened.sessionId, ...entries }).rows).length,
          1,
        );
        const config = await configApi.readModelsConfig({ kind: "local" });
        await configApi.saveModel(
          { kind: "local" },
          "CPA",
          { ...config.providers[0]!.models[0]!, baseUrl: `${base}/v1beta` },
          config,
        );
        await send();
        const completed = agentService.service.conversationSnapshot(key);
        assert.equal(
          visibleFailures(completed.rows.window).length,
          1,
          "successful retry does not erase or duplicate the historical failure",
        );
        assert.ok(
          completed.rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Local Gemini fixture success.",
          ),
        );
        assert.deepEqual(paths, [
          "/v1/models/gemini-4-carbon:streamGenerateContent?alt=sse",
          "/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse",
        ]);
        assert.ok(opened.sessionPath);
        await agentService.service.closeSession(key);
        const reopened = await agentService.service.resumeSession({
          sessionPath: opened.sessionPath,
          cwd,
        });
        assert.equal(visibleFailures(reopened.conversation.rows.window).length, 1);
      } finally {
        detach();
      }
    } finally {
      await agentService.dispose();
      configApi.dispose();
      if (previous === undefined) delete process.env.NEK_CODING_AGENT_DIR;
      else process.env.NEK_CODING_AGENT_DIR = previous;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
