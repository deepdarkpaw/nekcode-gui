import assert from "node:assert/strict";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { bundleRemoteAssets } from "../bundle-remote-assets.mjs";
import { createRemoteAssetFixture } from "./remoteAssetsFixture.mjs";
import {
  contentForPath,
  hasTestShell,
  remoteDeploymentFixture,
} from "./remoteDeploymentFixture.mjs";

const { formatRemoteAssetTransferProgress } = await tsImport("@zcode/shared", import.meta.url);
const options = { skip: !hasTestShell, timeout: 90_000 };
const liveFiles = [
  "node",
  "zcode-server.cjs",
  "build/Release/pty.node",
  "tools/bfs/bfs",
  "tools/ripgrep/rg",
  "tools/ugrep/ugrep",
];

function captureProgress(t) {
  const reports = [];
  const report = (...args) => reports.push(...args.filter((item) => item?.remoteAssetTransfer));
  t.mock.method(console, "log", report);
  t.mock.method(console, "warn", report);
  return () => reports;
}

async function assertInstalledAndClean(fixture) {
  for (const file of liveFiles) assert.ok((await stat(fixture.installed(file))).isFile(), file);
  const server = JSON.parse(
    await readFile(fixture.installed(".asset-components/server-bundle.json"), "utf8"),
  );
  assert.deepEqual(server, {
    id: "server-bundle",
    sha256: fixture.manifest.components.find(({ id }) => id === "server-bundle").sha256,
    platformArch: "linux-x64",
  });
  const node = JSON.parse(
    await readFile(fixture.installed(".asset-components/node-runtime.json"), "utf8"),
  );
  assert.deepEqual(node, {
    id: "node-runtime",
    version: fixture.manifest.components.find(({ id }) => id === "node-runtime").version,
    platformArch: "linux-x64",
  });
  assert.equal(
    await readFile(fixture.installed("tools/ripgrep/.version"), "utf8"),
    fixture.manifest.components.find(({ id }) => id === "ripgrep").version,
  );
  assert.ok(
    !(await readdir(fixture.installed(""))).some((name) => name.startsWith(".deploy.lock")),
  );
}

test(
  "first deployment, reconnect and missing component repair stay offline for local transports",
  options,
  async (t) => {
    const fixture = await remoteDeploymentFixture(t, { kind: "wsl", downloader: "curl" });
    const { deploy, uploads, installed, requests, commands } = fixture;
    assert.equal(await deploy(), true);
    assert.equal(uploads.length, 6);
    await assertInstalledAndClean(fixture);
    assert.equal(await deploy(), false);
    assert.equal(uploads.length, 6);
    for (const relativePath of ["node", "build/Release/pty.node", "tools/ripgrep/rg"]) {
      const before = uploads.length;
      await rm(installed(relativePath));
      await deploy();
      // 缺 Node 时旧 server 无法执行版本/能力探测；沿用原有重装两件的判定。
      const expected = before + (relativePath === "node" ? 2 : 1);
      assert.equal(uploads.length, expected, relativePath);
      assert.ok((await stat(installed(relativePath))).isFile());
      await deploy();
      assert.equal(uploads.length, expected);
    }
    assert.deepEqual(await requests(), []);
    assert.ok(commands.every((command) => !/\b(curl|wget)\b/.test(command)));
  },
);

for (const downloader of ["curl", "wget"]) {
  test(
    `SSH ${downloader} downloads verified release archives, and warm reconnect only probes`,
    options,
    async (t) => {
      const progress = captureProgress(t);
      const fixture = await remoteDeploymentFixture(t, { kind: "ssh", downloader });
      const { deploy, commands, uploads, requests, installed, version, manifest } = fixture;
      assert.equal(await deploy(), true);
      await assertInstalledAndClean(fixture);
      assert.deepEqual(uploads, []);
      const expected = manifest.components.map(
        ({ id }) =>
          `https://github.com/deepdarkpaw/nekcode-gui/releases/download/v${version}/nekcode-gui-server-${version}-linux-x64-${id}.tar.gz`,
      );
      assert.deepEqual((await requests()).sort(), expected.sort());
      assert.equal(commands.length, 4, "lock → probe → stage → commit on cold SSH");
      const reports = progress().filter((item) => item.remoteAssetTransfer === "release-download");
      assert.equal(reports.length, 2);
      assert.ok(reports[0].totalBytes > 0);
      assert.equal(reports[0].totalBytes, reports[1].totalBytes);
      assert.ok(reports[1].durationMs >= 0);

      assert.equal(await deploy(), false);
      assert.equal(commands.length, 6, "only lock and probe on warm SSH");
      assert.equal((await requests()).length, 6);
      await rm(installed("tools/ripgrep/rg"));
      assert.equal(await deploy(), false);
      assert.match((await requests()).at(-1), /-ripgrep\.tar\.gz$/u);
      assert.equal((await requests()).length, 7);
      assert.deepEqual(uploads, []);
    },
  );
}

for (const [downloader, behavior, reason, requests, code] of [
  ["curl", "404", "http", 1, 404],
  ["curl", "tampered", "checksum", 1],
  ["curl", "stalled", "stalled", 1],
  ["curl", "timeout", "timeout", 1],
  ["wget", "stalled", "stalled", 2],
  ["wget", "busybox-stalled", "stalled", 2],
  ["wget", "timeout", "timeout", 2],
  [undefined, "missing", "missing-downloader", 0],
]) {
  test(
    `SSH ${downloader ?? "no downloader"} ${behavior} emits a specific warning before bundled upload`,
    options,
    async (t) => {
      const progress = captureProgress(t);
      const fixture = await remoteDeploymentFixture(t, {
        kind: "ssh",
        downloader,
        behavior,
      });
      assert.equal(await fixture.deploy(), true);
      assert.equal(fixture.uploads.length, 6);
      assert.equal((await fixture.requests()).length, requests);
      await assertInstalledAndClean(fixture);
      const fallback = progress().find((item) => item.remoteAssetTransfer === "upload-fallback");
      assert.ok(fallback);
      assert.equal(fallback.reason, reason);
      assert.equal(fallback.statusCode, code);
      assert.ok(fallback.durationMs >= 0);
      const message = formatRemoteAssetTransferProgress(fallback);
      if (reason === "stalled") assert.match(message, /下载停滞/u);
      if (reason === "timeout") assert.match(message, /下载超时/u);
      const uploading = progress().find((item) => item.remoteAssetTransfer === "bundled-upload");
      assert.ok(uploading && progress().indexOf(fallback) < progress().indexOf(uploading));
      assert.ok(
        progress().some(
          (item) =>
            item.remoteAssetTransfer === "bundled-upload" &&
            item.totalBytes > 0 &&
            item.durationMs >= 0,
        ),
      );
    },
  );
}

test(
  "SSH cancellation during the download does not upload or publish and reclaims temporary files",
  options,
  async (t) => {
    const progress = captureProgress(t);
    const fixture = await remoteDeploymentFixture(t, {
      kind: "ssh",
      downloader: "curl",
      behavior: "cancel",
    });
    const abort = new AbortController();
    const error = fixture.deploy({ signal: abort.signal }).then(
      () => undefined,
      (failure) => failure,
    );
    try {
      for (let retry = 0; !(await fixture.requests()).length; retry++) {
        assert.ok(retry < 400, "fake download did not begin");
        await setTimeout(20);
      }
    } finally {
      abort.abort();
      assert.equal((await error)?.name, "AbortError");
    }
    assert.deepEqual(fixture.uploads, []);
    assert.ok(!progress().some((item) => item.remoteAssetTransfer === "upload-fallback"));
    assert.deepEqual(await readdir(fixture.installed("")), []);
  },
);

test(
  "a competing SSH deploy waits for the install-root owner and has no transfer side effects",
  options,
  async (t) => {
    const fixture = await remoteDeploymentFixture(t, { kind: "ssh", downloader: "curl" });
    const owner = await fixture.acquireLock();
    try {
      await assert.rejects(
        fixture.deploy({ deployLockAcquireTimeoutMs: 200 }),
        /lock acquisition timed out/,
      );
      assert.equal(fixture.commands.length, 2, "owner and waiter only");
      assert.deepEqual(await fixture.requests(), []);
      assert.deepEqual(fixture.uploads, []);
      assert.equal(
        await readFile(fixture.installed(".deploy.lock/owner"), "utf8"),
        owner.ownerToken,
      );
    } finally {
      await owner.release();
    }
  },
);

test("a damaged desktop bundle fails before any deployment command", options, async (t) => {
  const fixture = await remoteDeploymentFixture(t, { kind: "ssh", downloader: "curl" });
  await fixture.deploy();
  const before = await readFile(fixture.installed("zcode-server.cjs"));
  const commandCount = fixture.commands.length;
  await writeFile(
    join(fixture.options.outputDirectory, fixture.manifest.components[0].artifactPath),
    "corrupt",
  );
  await assert.rejects(fixture.deploy({ force: true }), /SHA256 mismatch/);
  assert.equal(fixture.commands.length, commandCount);
  assert.deepEqual(await readFile(fixture.installed("zcode-server.cjs")), before);
});

test(
  "identity changes, older server versions and missing feature markers still trigger repair",
  options,
  async (t) => {
    const { deploy, uploads, installed, version } = await remoteDeploymentFixture(t);
    await deploy();
    const toolUpdate = await createRemoteAssetFixture(
      t,
      (id, path) => contentForPath(id, path) + (id === "ripgrep" ? "\nupdated" : ""),
      version,
    );
    await bundleRemoteAssets(toolUpdate.options);
    const toolOptions = { bundledRemoteAssetsDir: toolUpdate.options.outputDirectory };
    assert.equal(await deploy(toolOptions), false);
    assert.equal(uploads.length, 7);
    assert.equal(await readFile(installed("tools/ripgrep/rg"), "utf8"), "fixture\nupdated");
    await deploy(toolOptions);
    assert.equal(uploads.length, 7);
    await writeFile(installed("zcode-server.cjs"), 'require("fs").writeSync(1, "0.0.0-old");');
    assert.equal(await deploy(toolOptions), true);
    await writeFile(
      installed("zcode-server.cjs"),
      `require("fs").writeSync(1, ${JSON.stringify(version)});`,
    );
    assert.equal(await deploy(toolOptions), true);
    const serverMarker = installed(".asset-components/server-bundle.json");
    const marker = JSON.parse(await readFile(serverMarker, "utf8"));
    await writeFile(serverMarker, JSON.stringify({ ...marker, sha256: "0".repeat(64) }));
    assert.equal(await deploy(toolOptions), true);
    await deploy(toolOptions);
    assert.equal(uploads.length, 10);
  },
);

test("unsupported targets are rejected before commands or upload", options, async (t) => {
  const { deploy, commands, uploads } = await remoteDeploymentFixture(t, {
    kind: "ssh",
    downloader: "curl",
  });
  await assert.rejects(deploy({}, { platform: "linux", arch: "arm64" }), /Unsupported/);
  assert.equal(commands.length, 0);
  assert.equal(uploads.length, 0);
});
