/**
 * nek 模型事实读取回归：渲染层草稿门禁靠它判断"能不能开始"。
 *
 * 现场：GUI 的 provider registry 在 nek build 里始终为空，门禁直接判成"没有可用模型"，
 * 发送被拦下并显示"请先配置一个可用模型"，而 nek 的 models.json 其实已经配好了。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readNekModelAvailability } from "../src/nek-agent/adapter/nekModelAvailability.js";

async function withAgentDir(
  files: Record<string, string>,
  run: (agentDir: string) => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "nek-model-availability-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(agentDir, name), content);
    }
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("models.json 有服务商与模型时可用，默认选择取自 settings.json", async () => {
  await withAgentDir(
    {
      "models.json": `{
        // nek 允许注释
        "providers": {
          "mock": { "models": [{ "id": "mock-model" }, { "id": "mock-model-2" }] },
          "empty": { "models": [] },
        }
      }`,
      "settings.json": `{ "defaultProvider": "mock", "defaultModel": "mock-model-2" }`,
    },
    async (agentDir) => {
      assert.deepEqual(await readNekModelAvailability(agentDir), {
        available: true,
        providerCount: 1,
        modelCount: 2,
        defaultSelection: { provider: "mock", model: "mock-model-2" },
      });
    },
  );
});

test("settings.json 缺默认值时退回第一条模型", async () => {
  await withAgentDir(
    {
      "models.json": `{ "providers": { "mock": { "models": [{ "id": "only-model" }] } } }`,
      "settings.json": "{}",
    },
    async (agentDir) => {
      assert.deepEqual(await readNekModelAvailability(agentDir), {
        available: true,
        providerCount: 1,
        modelCount: 1,
        defaultSelection: { provider: "mock", model: "only-model" },
      });
    },
  );
});

test("没有 models.json 或没有模型时不可用", async () => {
  await withAgentDir({}, async (agentDir) => {
    assert.deepEqual(await readNekModelAvailability(agentDir), {
      available: false,
      providerCount: 0,
      modelCount: 0,
    });
  });
  await withAgentDir(
    { "models.json": `{ "providers": { "mock": { "models": [] } } }` },
    async (agentDir) => {
      assert.deepEqual(await readNekModelAvailability(agentDir), {
        available: false,
        providerCount: 0,
        modelCount: 0,
      });
    },
  );
  await withAgentDir({ "models.json": "{ not json" }, async (agentDir) => {
    assert.equal((await readNekModelAvailability(agentDir)).available, false);
  });
});
