import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  createMemoryNekConfigFs,
  NekConfigConflictError,
} from "../src/nek-agent/config/nekConfigFs.js";
import type { NekConfigFs } from "../src/nek-agent/config/nekConfigFs.js";
import {
  readModels,
  removeModel,
  upsertModel,
  upsertProvider,
} from "../src/nek-agent/config/nekConfigModels.js";
import {
  applyProviderRename,
  planProviderRenameWith,
} from "../src/nek-agent/config/nekConfigRename.js";
import {
  NekConfigService,
  resolveNekConfigPaths,
} from "../src/nek-agent/config/nekConfigService.js";

/**
 * 配置服务的硬约束（ARD §3）：
 * - `settings.json` 走 nek 的锁，且只合并改动字段；
 * - 其它文件 `.tmp` + rename 原子写；
 * - 未知字段必须原样保留（nek 会持续加字段）；
 * - revision 变了就拒绝写（"外部已修改"）；
 * - 改服务商 ID 时，settings / agents 里的模型引用要一起改写。
 */

const agentDir = join("/home", "u", ".nek", "agent");
const projectDir = join("/work", "proj", ".nek");

function createService(options: { files?: Record<string, string> } = {}) {
  const fs = createMemoryNekConfigFs();
  for (const [path, content] of Object.entries(options.files ?? {})) fs.files.set(path, content);
  const ops: string[] = [];
  const recording: NekConfigFs = {
    ...fs,
    lock: {
      run: (path, critical) => {
        ops.push(`lock:${path}`);
        fs.lock.run(path, critical);
      },
    },
    writeFile: async (path, content) => {
      ops.push(`write:${path}`);
      await fs.writeFile(path, content);
    },
    rename: async (from, to) => {
      ops.push(`rename:${from}->${to}`);
      await fs.rename(from, to);
    },
    remove: (path) => {
      ops.push(`remove:${path}`);
      return fs.remove(path);
    },
  };
  const service = new NekConfigService({ paths: { agentDir, projectDir }, fs: recording });
  // `fs` 也要用记录版：models 的读写走注入的 fs，不看"原始"替身。
  return { fs: recording, service, ops, lockCount: () => fs.lockCallCount };
}

test("resolveNekConfigPaths honors NEK_CODING_AGENT_DIR and project .nek", () => {
  const paths = resolveNekConfigPaths({
    cwd: join("/work", "proj"),
    env: { NEK_CODING_AGENT_DIR: "/custom/agent" },
    home: "/home/u",
  });
  assert.equal(paths.agentDir, "/custom/agent");
  assert.equal(paths.projectDir, join("/work", "proj", ".nek"));
  const defaults = resolveNekConfigPaths({ cwd: join("/work", "proj"), env: {}, home: "/home/u" });
  assert.equal(defaults.agentDir, join("/home/u", ".nek", "agent"));
});

test("settings patch runs inside the shared lock and only touches changed fields", async () => {
  const original = {
    defaultProvider: "acme",
    defaultModel: "foo",
    theme: "dark",
    // nek 将来可能加的字段：GUI 不认识，但必须原样留着。
    experimentalFlag: { nested: true },
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const { service, fs, lockCount } = createService({
    files: { [join(agentDir, "settings.json")]: JSON.stringify(original, null, 2) },
  });
  const read = await service.readSettings();
  assert.ok(read.revision);
  const updated = await service.patchSettings(
    { defaultModel: "bar", compaction: { reserveTokens: 4096 } },
    { expectedRevision: read.revision },
  );
  assert.equal(lockCount(), 1, "settings must be written under proper-lockfile");
  assert.equal(updated.data.defaultModel, "bar");
  assert.equal(updated.data.defaultProvider, "acme");
  assert.equal(updated.data.theme, "dark");
  assert.deepEqual((updated.data as Record<string, unknown>).experimentalFlag, { nested: true });
  // 嵌套对象按子键合并：只改 reserveTokens，其余压缩设置保留。
  const compaction = updated.data.compaction as Record<string, unknown>;
  assert.equal(compaction.reserveTokens, 4096);
  assert.equal(compaction.enabled, true);
  assert.equal(compaction.keepRecentTokens, 20000);
  assert.equal(
    JSON.parse(fs.files.get(join(agentDir, "settings.json")) ?? "{}").defaultModel,
    "bar",
  );
  // settings 的写入不走 .tmp/rename：它靠锁保证互斥（与 nek 一致）。
  assert.equal(fs.files.has(`${join(agentDir, "settings.json")}.tmp`), false);
});

test("settings patch rejects a stale revision", async () => {
  const path = join(agentDir, "settings.json");
  const { service, fs } = createService({
    files: { [path]: JSON.stringify({ defaultModel: "a" }) },
  });
  const read = await service.readSettings();
  // 外部进程（终端里的 nek）改了同一个文件。
  fs.files.set(path, JSON.stringify({ defaultModel: "external" }));
  await assert.rejects(
    service.patchSettings({ defaultModel: "b" }, { expectedRevision: read.revision }),
    NekConfigConflictError,
  );
  assert.equal(JSON.parse(fs.files.get(path) ?? "{}").defaultModel, "external");
});

test("other files are written through .tmp + rename and keep unknown fields", async () => {
  const modelsPath = join(agentDir, "models.json");
  const { fs, ops } = createService({
    files: {
      [modelsPath]: JSON.stringify(
        {
          // 顶层未知字段（nek 未来可能加的全局开关）
          providers: {
            acme: {
              name: "Acme",
              baseUrl: "https://acme.test",
              api: "openai-completions",
              unknownKey: 7,
            },
          },
          globalSwitch: true,
        },
        null,
        2,
      ),
    },
  });
  const before = await readModels(fs, modelsPath);
  await upsertProvider(
    fs,
    modelsPath,
    "zeta",
    { name: "Zeta", baseUrl: "https://zeta.test" },
    before.revision,
  );
  assert.ok(ops.some((op) => op === `write:${modelsPath}.tmp`));
  assert.ok(ops.some((op) => op === `rename:${modelsPath}.tmp->${modelsPath}`));
  const after = await readModels(fs, modelsPath);
  assert.equal((after.data as Record<string, unknown>).globalSwitch, true);
  assert.equal((after.data.providers.acme as Record<string, unknown>).unknownKey, 7);
  assert.equal(after.data.providers.zeta?.name, "Zeta");
});

test("models.json edits preserve comments and model order", async () => {
  const modelsPath = join(agentDir, "models.json");
  const source = `{
  // 手工维护的注释必须活下来
  "providers": {
    "acme": {
      "baseUrl": "https://acme.test", // 行内注释
      "models": [
        { "id": "first" },
        { "id": "second" }
      ]
    }
  }
}
`;
  const { fs } = createService({ files: { [modelsPath]: source } });
  const before = await readModels(fs, modelsPath);
  assert.deepEqual(
    before.data.providers.acme?.models?.map((model) => model.id),
    ["first", "second"],
  );
  await upsertModel(fs, modelsPath, "acme", { id: "third" }, before.revision);
  const after = await readModels(fs, modelsPath);
  const text = fs.files.get(modelsPath) ?? "";
  assert.match(text, /手工维护的注释必须活下来/u);
  assert.match(text, /行内注释/u);
  assert.deepEqual(
    after.data.providers.acme?.models?.map((model) => model.id),
    ["first", "second", "third"],
  );
  await removeModel(fs, modelsPath, "acme", "second", after.revision);
  const removed = await readModels(fs, modelsPath);
  assert.deepEqual(
    removed.data.providers.acme?.models?.map((model) => model.id),
    ["first", "third"],
  );
});

test("models.json writes reject a stale revision", async () => {
  const modelsPath = join(agentDir, "models.json");
  const { fs } = createService({ files: { [modelsPath]: JSON.stringify({ providers: {} }) } });
  const before = await readModels(fs, modelsPath);
  fs.files.set(modelsPath, JSON.stringify({ providers: {}, external: 1 }));
  await assert.rejects(
    upsertProvider(fs, modelsPath, "x", { baseUrl: "https://x.test" }, before.revision),
    NekConfigConflictError,
  );
});

test("mcp servers: project scope only accepts override keys", async () => {
  const { service } = createService();
  const created = await service.upsertMcpServer("files", { command: "node", args: ["server.js"] });
  assert.equal(created.data.mcpServers.files !== undefined, true);
  await assert.rejects(
    service.upsertMcpServer("files", { command: "node" }, { scope: "project" }),
    /can only set enabled, exposure, toolExposure/u,
  );
  const override = await service.upsertMcpServer("files", { enabled: false }, { scope: "project" });
  assert.deepEqual(override.data.mcpServers.files, { enabled: false });
  await assert.rejects(
    service.upsertMcpServer("bad name!", { command: "node" }),
    /invalid MCP server name/u,
  );
});

test("nek.yaml patches merge top-level sections", async () => {
  const { service, fs } = createService({
    files: {
      [join(agentDir, "nek.yaml")]: "plan:\n  dir: .nek/plans\ntodo:\n  widgetMaxLines: 4\n",
    },
  });
  const read = await service.readNekYaml();
  assert.equal(read.data.todo?.widgetMaxLines, 4);
  const patched = await service.patchNekYaml(
    { todo: { widgetMaxLines: 8 } },
    { expectedRevision: read.revision },
  );
  assert.equal(patched.data.todo?.widgetMaxLines, 8);
  // 未改动的 section 保留。
  assert.equal(patched.data.plan?.dir, ".nek/plans");
  assert.match(fs.files.get(join(agentDir, "nek.yaml")) ?? "", /widgetMaxLines: 8/u);
});

test("agent presets round-trip frontmatter and body", async () => {
  const { service } = createService();
  const written = await service.writeAgentPreset({
    name: "reviewer",
    frontmatter: {
      name: "reviewer",
      description: "reviews code",
      tools: ["read", "grep"],
      model: "acme/foo",
    },
    body: "You review code.",
  });
  assert.equal(written.frontmatter.model, "acme/foo");
  assert.equal(written.body.trim(), "You review code.");
  const list = await service.listAgentPresets();
  assert.deepEqual(
    list.map((preset) => `${preset.scope}:${preset.name}`),
    ["global:reviewer"],
  );
  assert.equal(await service.deleteAgentPreset("reviewer"), true);
  assert.deepEqual(await service.listAgentPresets(), []);
});

test("provider rename rewrites every model reference and keeps the provider payload", async () => {
  const modelsPath = join(agentDir, "models.json");
  const settingsPath = join(agentDir, "settings.json");
  const presetPath = join(agentDir, "agents", "coder.md");
  const { service, fs } = createService({
    files: {
      [modelsPath]: JSON.stringify(
        {
          providers: {
            acme: {
              name: "Acme",
              baseUrl: "https://acme.test",
              models: [{ id: "foo" }, { id: "bar" }],
              modelOverrides: { "acme/foo": { name: "Foo!" } },
            },
            other: { baseUrl: "https://other.test" },
          },
        },
        null,
        2,
      ),
      [settingsPath]: JSON.stringify(
        {
          defaultProvider: "acme",
          defaultModel: "foo",
          enabledModels: ["acme/foo:high", "other/x"],
          compaction: { model: "acme/bar", modelOverrides: { "acme/bar": { enabled: false } } },
          modelThinkingLevels: { "acme/foo": "high", "other/x": "low" },
        },
        null,
        2,
      ),
      [presetPath]: `---\nname: coder\ndescription: writes code\nmodel: acme/foo\n---\n\nBody text.\n`,
    },
  });
  const plan = await planProviderRenameWith({
    fs,
    modelsPath,
    settingsSource: service,
    from: "acme",
    to: "zeta",
  });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.models.modelCount, 2);
  assert.equal(plan.settings.patch.defaultProvider, "zeta");
  assert.deepEqual(plan.settings.patch.enabledModels, ["zeta/foo:high", "other/x"]);
  assert.equal((plan.settings.patch.compaction as Record<string, unknown>).model, "zeta/bar");
  assert.deepEqual(plan.settings.patch.modelThinkingLevels, {
    "zeta/foo": "high",
    "other/x": "low",
  });
  assert.deepEqual(
    plan.agents.map((agent) => agent.rewrite.to),
    ["zeta/foo"],
  );

  await applyProviderRename(fs, service, plan);
  const models = await readModels(fs, modelsPath);
  assert.equal(models.data.providers.acme, undefined);
  assert.deepEqual(
    models.data.providers.zeta?.models?.map((model) => model.id),
    ["foo", "bar"],
  );
  assert.deepEqual(models.data.providers.zeta?.modelOverrides?.["acme/foo"], { name: "Foo!" });
  const settings = await service.readSettings();
  assert.equal(settings.data.defaultProvider, "zeta");
  assert.deepEqual(settings.data.enabledModels, ["zeta/foo:high", "other/x"]);
  assert.equal((settings.data.compaction as Record<string, unknown>).model, "zeta/bar");
  assert.deepEqual(settings.data.modelThinkingLevels, { "zeta/foo": "high", "other/x": "low" });
  const preset = await service.readAgentPreset("coder");
  assert.equal(preset?.frontmatter.model, "zeta/foo");
  // 正文不能被改名顺手清空。
  assert.equal(preset?.body.trim(), "Body text.");
});

test("provider rename refuses a target that already exists", async () => {
  const modelsPath = join(agentDir, "models.json");
  const { service, fs } = createService({
    files: {
      [modelsPath]: JSON.stringify({ providers: { acme: {}, other: {} } }),
      [join(agentDir, "settings.json")]: JSON.stringify({}),
    },
  });
  const plan = await planProviderRenameWith({
    fs,
    modelsPath,
    settingsSource: service,
    from: "acme",
    to: "other",
  });
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0] ?? "", /already exists/u);
  await assert.rejects(applyProviderRename(fs, service, plan), /cannot rename provider/u);
});
