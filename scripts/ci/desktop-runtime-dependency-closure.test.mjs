import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectRuntimeModuleClosureEntries,
  resolveInstallPath,
} from "../../packages/desktop/scripts/runtime-dependency-closure.mjs";

async function writePackage(dir, name, version, dependencies = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js", dependencies }),
  );
  await writeFile(join(dir, "index.js"), "module.exports = {};\n");
}

test("resolveInstallPath keeps nested placement and flattens the pnpm store", () => {
  assert.equal(resolveInstallPath("/repo/node_modules/retry", "retry"), "retry");
  assert.equal(
    resolveInstallPath(
      "C:\\repo\\node_modules\\proper-lockfile\\node_modules\\signal-exit",
      "signal-exit",
    ),
    "proper-lockfile/node_modules/signal-exit",
  );
  assert.equal(resolveInstallPath("/repo/node_modules/@scope/pkg", "@scope/pkg"), "@scope/pkg");
  assert.equal(
    resolveInstallPath("/repo/node_modules/.pnpm/node_modules/signal-exit", "signal-exit"),
    "signal-exit",
  );
});

test("nested dependency versions are collected at their real install path", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-closure-"));
  try {
    const modules = join(root, "node_modules");
    // hoisted v4 被别的包使用；proper-lockfile 需要嵌套的 v3。
    await writePackage(join(modules, "signal-exit"), "signal-exit", "4.1.0");
    await writePackage(join(modules, "retry"), "retry", "0.12.0");
    await writePackage(join(modules, "proper-lockfile"), "proper-lockfile", "4.1.2", {
      retry: "^0.12.0",
      "signal-exit": "^3.0.2",
    });
    await writePackage(
      join(modules, "proper-lockfile", "node_modules", "signal-exit"),
      "signal-exit",
      "3.0.7",
    );
    await writePackage(join(modules, "other"), "other", "1.0.0", { "signal-exit": "^4.0.0" });

    const entries = collectRuntimeModuleClosureEntries(["proper-lockfile", "other"], [root]);
    const installPaths = entries.map((entry) => entry.installPath).sort();
    assert.deepEqual(installPaths, [
      "other",
      "proper-lockfile",
      "proper-lockfile/node_modules/signal-exit",
      "retry",
      "signal-exit",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
