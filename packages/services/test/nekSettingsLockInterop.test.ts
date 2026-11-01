import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createLocalNekConfigHostExecutor } from "../src/nek-config-api/hostExecutor.js";

const nekWorktree = process.env.NEK_RPC_WORKTREE;
const skipReason = !nekWorktree
  ? "NEK_RPC_WORKTREE is not set; the nek SettingsManager interop test is skipped"
  : process.env.NEK_E2E !== "1"
    ? "set NEK_E2E=1 to run the nek SettingsManager interop test"
    : false;

/**
 * 子进程脚本：用 nek 真实的 `FileSettingsStorage.withLock` 写入 `lastChangelogVersion`。
 * `holdMs > 0` 时拿到锁后先在 stdout 打印 `locked` 并持锁一段时间。
 */
function nekWriterScript(settingsManagerPath: string): string {
  return `
import { FileSettingsStorage } from ${JSON.stringify(pathToFileURL(settingsManagerPath).href)};
const [agentDir, holdMs] = process.argv.slice(2);
new FileSettingsStorage(agentDir, agentDir).withLock("global", (current) => {
  process.stdout.write("locked\\n");
  const end = Date.now() + Number(holdMs);
  while (Date.now() < end) {}
  return JSON.stringify({ ...JSON.parse(current ?? "{}"), lastChangelogVersion: "0.3.2" });
});
`;
}

async function fixture() {
  assert.ok(nekWorktree);
  const dir = await mkdtemp(join(tmpdir(), "nek-gui-settings-lock-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
  const script = join(dir, "nek-writer.mjs");
  const settingsManager = join(nekWorktree, "packages/coding-agent/src/core/settings-manager.ts");
  await writeFile(script, nekWriterScript(settingsManager));
  const lock = createLocalNekConfigHostExecutor({ home: dir, agentDir: dir }).lock;
  assert.ok(lock, "the local executor must provide the settings lock");
  return { dir, settingsPath, script, lock };
}

const readSettings = async (path: string) =>
  JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;

test(
  "nek's SettingsManager cannot write while the GUI holds the settings lock",
  { skip: skipReason },
  async () => {
    const { dir, settingsPath, script, lock } = await fixture();
    try {
      await lock.runLocked(settingsPath, (current) => {
        const blocked = spawnSync(process.execPath, [script, dir, "0"], { encoding: "utf-8" });
        assert.notEqual(blocked.status, 0, "nek must not acquire the lock the GUI holds");
        assert.match(blocked.stderr, /ELOCKED|already being held/);
        return JSON.stringify({ ...JSON.parse(current ?? "{}"), defaultModel: "mock/mock-model" });
      });
      const after = spawnSync(process.execPath, [script, dir, "0"], { encoding: "utf-8" });
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(await readSettings(settingsPath), {
        theme: "dark",
        defaultModel: "mock/mock-model",
        lastChangelogVersion: "0.3.2",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the GUI cannot write while nek's SettingsManager holds the settings lock",
  { skip: skipReason },
  async () => {
    const { dir, settingsPath, script, lock } = await fixture();
    try {
      const child = spawn(process.execPath, [script, dir, "1500"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("exit", (code) => reject(new Error(`nek writer exited early with ${code}`)));
      });
      const write = (field: string) => (current: string | undefined) =>
        JSON.stringify({ ...JSON.parse(current ?? "{}"), [field]: true });
      assert.throws(
        () => lock.runLocked(settingsPath, write("blocked")),
        /ELOCKED|already being held/,
      );
      assert.equal(await exited, 0);
      await lock.runLocked(settingsPath, write("afterNek"));
      assert.deepEqual(await readSettings(settingsPath), {
        theme: "dark",
        lastChangelogVersion: "0.3.2",
        afterNek: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
