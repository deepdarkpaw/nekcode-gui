import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { DEFAULT_GUI_RUNTIME_CONFIG, parseGuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import { loadGuiRuntimeConfig } from "../src/nek-agent/guiRuntimeConfigLoader.ts";

const repoConfigPath = join(import.meta.dirname, "..", "..", "..", "config", "config.yaml");

function memoryReader(files: Record<string, string>) {
  return async (path: string) => files[path];
}

test("仓库 config/config.yaml 与内置默认值一致且没有诊断", () => {
  const result = parseGuiRuntimeConfig(parseYaml(readFileSync(repoConfigPath, "utf8")));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.config, DEFAULT_GUI_RUNTIME_CONFIG);
});

test("缺失文件时使用默认值", async () => {
  const loaded = await loadGuiRuntimeConfig(
    [{ path: "/missing.yaml", label: "bundled" }],
    memoryReader({}),
  );
  assert.deepEqual(loaded.config, DEFAULT_GUI_RUNTIME_CONFIG);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.loadedFrom, []);
});

test("用户文件按键覆盖随包文件，未写的键保留", async () => {
  const loaded = await loadGuiRuntimeConfig(
    [
      { path: "/bundled.yaml", label: "bundled" },
      { path: "/user.yaml", label: "user" },
    ],
    memoryReader({
      "/bundled.yaml": "nek:\n  maxSessionProcesses: 6\n  idleMinutes: 15\n",
      "/user.yaml": "nek:\n  idleMinutes: 30\n",
    }),
  );
  assert.equal(loaded.config.nek.maxSessionProcesses, 6);
  assert.equal(loaded.config.nek.idleMinutes, 30);
  assert.equal(loaded.config.nek.stderrBufferKb, DEFAULT_GUI_RUNTIME_CONFIG.nek.stderrBufferKb);
  assert.deepEqual(loaded.loadedFrom, ["/bundled.yaml", "/user.yaml"]);
});

test("非法键回退到默认值并带来源诊断，其他键照常生效", async () => {
  const loaded = await loadGuiRuntimeConfig(
    [{ path: "/user.yaml", label: "user" }],
    memoryReader({
      "/user.yaml": "nek:\n  idleMinutes: -1\n  maxSessionProcesses: 4\n  bogus: 1\nmystery: {}\n",
    }),
  );
  assert.equal(loaded.config.nek.idleMinutes, DEFAULT_GUI_RUNTIME_CONFIG.nek.idleMinutes);
  assert.equal(loaded.config.nek.maxSessionProcesses, 4);
  const paths = loaded.diagnostics.map((diagnostic) => diagnostic.path).sort();
  assert.deepEqual(paths, ["user:mystery", "user:nek.bogus", "user:nek.idleMinutes"]);
});

test("YAML 语法错误只产生诊断，不中断加载", async () => {
  const loaded = await loadGuiRuntimeConfig(
    [
      { path: "/bundled.yaml", label: "bundled" },
      { path: "/user.yaml", label: "user" },
    ],
    memoryReader({
      "/bundled.yaml": "input:\n  undoToastMs: 3000\n",
      "/user.yaml": "nek: [unclosed\n",
    }),
  );
  assert.equal(loaded.config.input.undoToastMs, 3000);
  assert.equal(loaded.diagnostics.length, 1);
  assert.match(loaded.diagnostics[0]!.path, /^user:/);
});

test("根节点不是映射时整体回退默认值", () => {
  const result = parseGuiRuntimeConfig(["not", "a", "mapping"]);
  assert.deepEqual(result.config, DEFAULT_GUI_RUNTIME_CONFIG);
  assert.equal(result.diagnostics.length, 1);
});
