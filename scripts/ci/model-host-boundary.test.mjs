import assert from "node:assert/strict";
import test from "node:test";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 模型交通的 Host 边界。
 *
 * GUI 从不自己发模型请求：所有 provider / model 调用都由 nek 进程完成，
 * GUI 侧只写配置、透传命令。任何在 GUI 里新长出来的 HTTP 客户端或
 * provider runtime header 端口都会让用户凭据与身份从 Host 泄漏出去。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const NEK_INTEGRATION_DIRS = [
  "packages/services/src/nek-agent",
  "packages/services/src/nek-config-api",
  "packages/shared/src/nek-protocol",
];

/** 模型流量与凭据注入的痕迹；`fetch_provider_models` 这类 RPC 名字不算。 */
const FORBIDDEN_MODEL_TRANSPORT = [
  { pattern: /\bfetch\s*\(/, label: "fetch()" },
  { pattern: /\baxios\b/, label: "axios" },
  { pattern: /from\s+["']node:https?["']/, label: "node:http(s)" },
  { pattern: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  { pattern: /\bnew\s+WebSocket\b/, label: "WebSocket" },
  { pattern: /\/chat\/completions/, label: "/chat/completions" },
];

async function sourceFiles(dir) {
  const absolute = join(repoRoot, dir);
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(relative)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(relative);
  }
  return files;
}

test("the GUI-side nek integration never issues provider or model requests of its own", async () => {
  const files = (await Promise.all(NEK_INTEGRATION_DIRS.map(sourceFiles))).flat();
  assert.ok(files.length > 0, "必须扫描到 nek 集成源码");
  for (const file of files) {
    const source = await readFile(join(repoRoot, file), "utf8");
    for (const { pattern, label } of FORBIDDEN_MODEL_TRANSPORT) {
      assert.doesNotMatch(
        source,
        pattern,
        `${file} 不得自行发起模型流量（${label}）：模型请求只能由 nek 进程发出`,
      );
    }
  }
});

test("retired zcode agent runtime and provider runtime header ports stay removed", async () => {
  for (const file of [
    "packages/services/src/zcode-agent/zcodeAgentService.ts",
    "packages/services/src/zcode-agent/zcodeAgentProcessManager.ts",
    "packages/services/src/zcode-agent/zcodeProtocolClient.ts",
    "packages/services/src/zcode-agent/zcodeAgentPresentationSurface.ts",
  ]) {
    await assert.rejects(
      access(join(repoRoot, file)),
      { code: "ENOENT" },
      `${file} 必须保持删除，不能留下第二条 agent 运行时或身份注入端口`,
    );
  }
  for (const file of [
    "packages/services/src/node.ts",
    "packages/services/src/index.ts",
    "packages/services/src/nek-agent/index.ts",
    "packages/desktop/src/host/index.ts",
  ]) {
    const source = await readFile(join(repoRoot, file), "utf8");
    assert.doesNotMatch(
      source,
      /providerRuntimeHeaders|requestProviderRuntimeHeaders/,
      `${file} 不得重新导出 provider runtime header 端口`,
    );
  }
});
