/** Opt-in: two GUI session owners share an isolated agentDir with a separate settings writer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { NekGuiInfo, NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { createNekRuntimeServices } from "../src/createNekRuntimeServices.js";
import { spawnNekProcess } from "../src/nek-agent/nekProcessLauncher.js";
import { createNekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import { createLocalNekConfigHostExecutor, NekConfigApi } from "../src/nek-config-api/index.js";

const source = process.env.NEK_RPC_WORKTREE;
const local = { kind: "local" } as const;
const destination = { kind: "remote", connectionId: "test-destination" } as const;

async function until(label: string, predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(40);
  }
}

test(
  "real nek: copying to a machine refreshes two existing owners and defers a busy turn",
  {
    skip: process.env.NEK_E2E !== "1" || !source ? "set NEK_E2E=1 and NEK_RPC_WORKTREE" : false,
    timeout: 120_000,
  },
  async (t) => {
    const temp = resolve(process.env.NEK_E2E_TMP ?? ".tmp");
    await mkdir(temp, { recursive: true });
    const root = await mkdtemp(join(temp, "machine-reload-"));
    const agentDir = join(root, "destination");
    const src = join(root, "source");
    const projects = [join(root, "alpha"), join(root, "beta")];
    await Promise.all([agentDir, src, ...projects].map((p) => mkdir(p)));
    const releaseTurn = Promise.withResolvers<void>();
    let requests = 0;
    const server = createServer(async (_req, res) => {
      requests++;
      await releaseTurn.promise;
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
      releaseTurn.resolve();
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "fixture-only",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            models: [{ id: "fixture", contextWindow: 65536, maxTokens: 1024 }],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture",
        defaultModel: "fixture",
        defaultProjectTrust: "always",
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    await writeFile(join(src, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
    await writeFile(
      join(src, "mcp.json"),
      JSON.stringify({
        mcpServers: { afterCopy: { command: "fixture-not-started", enabled: false } },
      }),
    );
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "unused-fixture" } }),
    );
    const env = {
      HOME: root,
      USERPROFILE: root,
      NEK_CODING_AGENT_DIR: agentDir,
      NEK_OFFLINE: "1",
      TMP: root,
      TEMP: root,
    };
    const args = [
      "--import",
      pathToFileURL(join(source!, "packages/coding-agent/src/experimental/source-resolver.ts"))
        .href,
      join(source!, "packages/coding-agent/src/cli.ts"),
    ];
    const probe = spawnSync(process.execPath, [...args, "gui-info", "--json"], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    const info: NekGuiInfo = JSON.parse(probe.stdout);
    assert.equal(resolve(info.agentDir), agentDir);
    const dst = createLocalNekConfigHostExecutor({ agentDir, home: root });
    dst.spawnNek = async (argv) =>
      spawnNekProcess({ guiInfo: info, cwd: root, env, args: [...argv] }).handle;
    const srcExecutor = createLocalNekConfigHostExecutor({ agentDir: src, home: root });
    const writer = new NekConfigApi({
      hosts: {
        executor: (target) => (target.kind === "local" ? srcExecutor : dst),
        listTargets: async () => [],
      },
    });
    t.after(() => writer.dispose());
    const owners = projects.map((cwd) =>
      createNekRuntimeServices({
        agent: {
          guiInfo: info,
          cwd,
          askProjectTrust: () => "trust",
          createControlProcess: () =>
            createNekRpcProcess({ guiInfo: info, cwd, env, control: true }),
          createSessionProcess: (r) =>
            createNekRpcProcess({
              guiInfo: info,
              cwd: r.cwd,
              env,
              approve: true,
              sessionPath: r.sessionPath,
            }),
        },
        config: { hosts: { executor: () => dst, listTargets: async () => [] } },
      }),
    );
    t.after(async () => {
      releaseTurn.resolve();
      await Promise.all(
        owners.map(async (owner) => {
          await owner.agentService.dispose();
          owner.configApi.dispose();
        }),
      );
    });
    const tasks = await Promise.all(
      owners.map((owner, i) =>
        owner.agentService.service.createSession({
          cwd: projects[i]!,
          model: { provider: "fixture", modelId: "fixture" },
        }),
      ),
    );
    const pids = () =>
      owners.map(
        (owner, i) => owner.agentService.service.getSession(tasks[i]!.sessionKey)?.processId,
      );
    const before = pids();
    const events = owners.map((owner) => {
      const log: NekSessionReloadOutcome[] = [];
      const stop = owner.configApi.onReloadResult(local, (outcome) => {
        if (log.length < 64) log.push(outcome);
      });
      t.after(stop);
      return log;
    });
    const mcpLoaded = async (i: number) =>
      Boolean(
        (await owners[i]!.configApi.getMcpStatus(local, projects[i]))?.some(
          (row) => row.name === "afterCopy",
        ),
      );
    assert.equal(await mcpLoaded(0), false);
    const busy = owners[1]!.agentService.service;
    const prompt = busy.sendPrompt({
      sessionKey: tasks[1]!.sessionKey,
      message: "Answer ok without tools.",
    });
    try {
      await until("loopback request", () => requests === 1);
      const result = await writer.copy(
        local,
        destination,
        { providers: [], logins: [], mcpServers: ["afterCopy"], defaults: false, compaction: true },
        { "compaction:compaction": "overwrite" },
      );
      assert.deepEqual(
        result.items.map((item) => item.status),
        ["copied", "copied"],
      );
      await until(
        "idle owner acknowledged and busy owner deferred",
        () =>
          events[0]!.some((e) => e.trigger === "write" && e.reloaded === 1) &&
          events[1]!.some((e) => e.trigger === "write" && e.deferred === 1),
      );
      await until("idle MCP updated", () => mcpLoaded(0));
    } finally {
      releaseTurn.resolve();
      await prompt;
    }
    await until("busy MCP updated after turn", () => mcpLoaded(1));
    const auth = async () =>
      (await writer.getAuthStatus(destination)).find((p) => p.provider === "anthropic")?.kind;
    assert.equal(await auth(), "api_key");
    await writer.logout(destination, "anthropic");
    assert.notEqual(await auth(), "api_key");
    await until("logout delivered to both owners", () =>
      events.every((log) => log.some((e) => e.trigger === "login" && e.reloaded === 1)),
    );
    assert.deepEqual(pids(), before, "do not restart the conversations");
    assert.equal(requests, 1, "only the fixture turn reached the loopback model");
  },
);
