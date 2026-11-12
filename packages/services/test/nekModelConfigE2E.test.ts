/** Real CLI + production composition + real files. Network requests go only to a loopback fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { createLocalNekConfigHostExecutor, NekConfigApi } from "../src/nek-config-api/index.js";
import { spawnNekProcess } from "../src/nek-agent/nekProcessLauncher.js";

const source = process.env.NEK_RPC_WORKTREE;
const enabled = process.env.NEK_E2E === "1" && Boolean(source);

test(
  "real nek: settings owner writes -> existing host session selects and sends new/same-ID models without restart",
  { skip: enabled ? false : "set NEK_E2E=1 and NEK_RPC_WORKTREE", timeout: 120_000 },
  async () => {
    const { createNekRuntimeServices } = await import("../src/createNekRuntimeServices.js");
    const root = resolve(process.env.NEK_E2E_TMP ?? ".tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "model-config-e2e-"));
    const agentDir = join(dir, "agent");
    const project = join(dir, "project");
    await mkdir(agentDir);
    await mkdir(project);
    const requests: Array<{ url?: string; model: string }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requests.push({ url: request.url, model: parsed.model });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choices of [
        [
          {
            index: 0,
            delta: { role: "assistant", content: "Local fixture reply." },
            finish_reason: null,
          },
        ],
        [{ index: 0, delta: {}, finish_reason: "stop" }],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: parsed.model, choices })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const path = join(agentDir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          CPA: {
            baseUrl: `${base}/old`,
            apiKey: "fixture-only",
            models: [
              { id: "old", api: "openai-completions", contextWindow: 100000, maxTokens: 1024 },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "CPA",
        defaultModel: "old",
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultProjectTrust: "always",
      }),
    );
    const previous = process.env.NEK_CODING_AGENT_DIR;
    process.env.NEK_CODING_AGENT_DIR = agentDir;
    const info: NekGuiInfo = {
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
    executor.spawnNek = async (args) =>
      spawnNekProcess({ guiInfo: info, cwd: project, args: [...args] }).handle;
    const hosts = { executor: () => executor, listTargets: async () => [] };
    // A separate config owner models Electron main; the host learns via fs.watch/content admission.
    const settings = new NekConfigApi({ hosts });
    const host = createNekRuntimeServices({
      agent: { guiInfo: info, cwd: project, askProjectTrust: () => true },
      config: { hosts, config: { watchDebounceMs: 60_000 } },
    });
    const local = { kind: "local" } as const;
    try {
      const created = await host.agentService.service.createSession({
        cwd: project,
        model: { provider: "CPA", modelId: "old" },
      });
      const key = created.sessionKey;
      const pid = host.agentService.service.getSession(key)?.processId;
      const send = async () => {
        let stop = () => {};
        let timer: ReturnType<typeof setTimeout>;
        const settled = new Promise<void>((done, reject) => {
          timer = setTimeout(() => reject(new Error("local mock turn did not settle")), 30_000);
          stop = host.agentService.service.onEvent((event) => {
            if (
              event.type === "rpc_event" &&
              event.session.sessionKey === key &&
              event.event.type === "agent_settled"
            )
              done();
          });
        });
        try {
          await host.agentService.service.sendPrompt({
            sessionKey: key,
            message: "Reply briefly. Do not use tools.",
          });
          await settled;
        } finally {
          stop();
          clearTimeout(timer!);
        }
      };
      const initial = await settings.readModelsConfig(local);
      await assert.rejects(
        settings.addModels(local, "CPA", [{ id: "missing-api" }], initial),
        /requires "api"/,
      );
      await settings.addModels(
        local,
        "CPA",
        [
          {
            id: "gemini-4-carbon",
            api: "openai-completions",
            contextWindow: 100000,
            maxTokens: 1024,
          },
        ],
        initial,
      );
      await host.agentService.service.setModel({
        sessionKey: key,
        provider: "CPA",
        modelId: "gemini-4-carbon",
      });
      await send();
      assert.deepEqual(requests.at(-1), { url: "/old/chat/completions", model: "gemini-4-carbon" });
      const config = await settings.readModelsConfig(local);
      const model = config.providers[0]!.models.find((item) => item.id === "gemini-4-carbon")!;
      await settings.saveModel(local, "CPA", { ...model, baseUrl: `${base}/updated` }, config);
      // No new selection: current session model object must also be rebound, not just its catalog.
      await send();
      assert.deepEqual(requests.at(-1), {
        url: "/updated/chat/completions",
        model: "gemini-4-carbon",
      });
      const raw = JSON.parse(await readFile(path, "utf8"));
      raw.providers.CPA.models[1].api = "openai-responses";
      await writeFile(path, JSON.stringify(raw));
      const selected = await host.agentService.service.setModel({
        sessionKey: key,
        provider: "CPA",
        modelId: "gemini-4-carbon",
      });
      assert.equal(selected.api, "openai-responses");
      assert.equal(
        host.agentService.service.getSession(key)?.processId,
        pid,
        "configuration changes never rebuild the session",
      );
      assert.equal(requests.length, 2, "only the loopback requests were made");
    } finally {
      await host.agentService.dispose();
      host.configApi.dispose();
      settings.dispose();
      if (previous === undefined) delete process.env.NEK_CODING_AGENT_DIR;
      else process.env.NEK_CODING_AGENT_DIR = previous;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
