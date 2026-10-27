import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { LocalUploadAssetInstaller } = await tsImport(
  "../../packages/server/src/remote/remoteAssetInstaller.ts",
  import.meta.url,
);

async function fixture(t, { corrupt = false, controller } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-upload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "binary"), "new verified bytes");
  const commands = [];
  const backend = {
    async upload(from, to) {
      await copyFile(from, to);
      if (corrupt) await writeFile(to, "corrupted transport");
      controller?.abort();
    },
    async exec(command) {
      commands.push(command);
      assert.doesNotMatch(command, /\b(curl|wget)\b/);
      const child = spawn("/bin/sh", ["-c", command], { cwd: root });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onClose: (listener) => {
          child.once("close", listener);
          return { dispose: () => child.off("close", listener) };
        },
      };
    },
  };
  const installer = new LocalUploadAssetInstaller(
    backend,
    { releaseDir: source, signal: controller?.signal },
    { log() {}, logWarn() {} },
  );
  return { root, installer, commands };
}

test(
  "verified uploads replace files without any download tool",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, installer } = await fixture(t);
    const path = join(root, "installed");
    await installer.installFile({
      componentId: "node-runtime",
      sourceRelativePath: "binary",
      remotePath: path,
      executable: true,
    });
    assert.equal(await readFile(path, "utf8"), "new verified bytes");
  },
);

test(
  "corrupted upload fails before replacing the installed file",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, installer } = await fixture(t, { corrupt: true });
    const path = join(root, "installed");
    await writeFile(path, "old working file");
    await assert.rejects(
      installer.installFile({
        componentId: "node-runtime",
        sourceRelativePath: "binary",
        remotePath: path,
      }),
    );
    assert.equal(await readFile(path, "utf8"), "old working file");
  },
);

test(
  "abort after upload never replaces the live file or reconnects for cleanup",
  { skip: process.platform === "win32" },
  async (t) => {
    const controller = new AbortController();
    const { root, installer, commands } = await fixture(t, { controller });
    const path = join(root, "installed");
    await writeFile(path, "old");
    await assert.rejects(
      installer.installFile({
        componentId: "node-runtime",
        sourceRelativePath: "binary",
        remotePath: path,
      }),
      { name: "AbortError" },
    );
    assert.equal(await readFile(path, "utf8"), "old");
    assert.ok(!commands.some((command) => command.includes("command mv")));
  },
);
