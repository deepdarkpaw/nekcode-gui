import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { distWin } from "../dist-win.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
  resolveGithubPublishOwner,
  resolveGithubPublishRepo,
} from "../../packages/desktop/scripts/desktop-product-identity.mjs";

const root = new URL("../../", import.meta.url);

function successfulRun(calls) {
  return (command, args, options) => {
    calls.push({ command, args, ...options });
    return { status: 0, signal: null };
  };
}

test("dist:win prepares current runtime assets, bootstraps, then bundles Windows x64 once", () => {
  const calls = [];
  const env = {
    ZCODE_ENV: "test",
    ZCODE_PREVIEW_IDENTITY: "1",
    ZCODE_SKIP_REMOTE_ASSETS: "1",
    ZCODE_TARGET_OS: "linux",
    ZCODE_TARGET_ARCH: "arm64",
    NEKCODE_UPDATE_OWNER: "fork-owner",
    NEKCODE_UPDATE_REPO: "fork-repo",
  };
  distWin({ env, run: successfulRun(calls) });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["prepare:desktop-runtime"],
      ["build:bootstrap"],
      ["bundle:desktop", "--", "--os", "win", "--arch", "x64", "--skip-prepare", "--skip-build"],
    ],
  );
  for (const call of calls) {
    assert.equal(call.command, "pnpm");
    assert.equal(call.cwd, resolve(fileURLToPath(root)));
    assert.equal(call.env.ZCODE_ENV, "production");
    assert.equal(call.env.ZCODE_PREVIEW_IDENTITY, "0");
    assert.equal(call.env.ZCODE_SKIP_REMOTE_ASSETS, "0");
    assert.equal(call.env.ZCODE_TARGET_OS, "win");
    assert.equal(call.env.ZCODE_TARGET_ARCH, "x64");
    assert.equal(resolveDesktopProductIdentity(call.env).productName, "nekcode");
    assert.equal(resolveDesktopArtifactSuffix(call.env), "");
    assert.equal(resolveGithubPublishOwner(call.env), "fork-owner");
    assert.equal(resolveGithubPublishRepo(call.env), "fork-repo");
  }
  assert.equal(env.ZCODE_ENV, "test", "must not mutate the caller environment");
});

for (const failedStep of [0, 1, 2]) {
  test(`dist:win stops when step ${failedStep + 1} fails`, () => {
    let count = 0;
    assert.throws(
      () => distWin({ env: {}, run: () => ({ status: count++ === failedStep ? 7 : 0 }) }),
      /exit 7/,
    );
    assert.equal(count, failedStep + 1);
  });
}

test("dist:win propagates spawn errors and treats termination as failure", () => {
  assert.throws(
    () =>
      distWin({
        run: () => {
          throw new Error("spawn failed");
        },
      }),
    /spawn failed/,
  );
  assert.throws(
    () => distWin({ run: () => ({ status: null, signal: "SIGTERM" }) }),
    /signal SIGTERM/,
  );
});

test("GitHub publishing defaults to the public repository and preserves trimmed overrides", () => {
  assert.equal(resolveGithubPublishOwner({}), "deepdarkpaw");
  assert.equal(resolveGithubPublishRepo({}), "nekcode-gui");
  assert.equal(resolveGithubPublishOwner({ NEKCODE_UPDATE_OWNER: "  " }), "deepdarkpaw");
  assert.equal(resolveGithubPublishRepo({ NEKCODE_UPDATE_REPO: "  " }), "nekcode-gui");
  assert.equal(resolveGithubPublishOwner({ NEKCODE_UPDATE_OWNER: " fork " }), "fork");
  assert.equal(resolveGithubPublishRepo({ NEKCODE_UPDATE_REPO: " fork-gui " }), "fork-gui");
});

test("root command and NSIS defaults implement the documented production installation", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.scripts["dist:win"], "node scripts/dist-win.mjs");
  const config = readFileSync(new URL("packages/desktop/electron-builder.config.js", root), "utf8");
  for (const field of [
    "oneClick: false",
    "perMachine: false",
    "selectPerMachineByDefault: false",
    "allowToChangeInstallationDirectory: true",
    "createStartMenuShortcut: true",
    "createDesktopShortcut: true",
    "runAfterFinish: true",
    "shortcutName: desktopProductIdentity.productName",
    "uninstallDisplayName: desktopProductIdentity.productName",
  ]) {
    assert.ok(config.includes(field), field);
  }
  const installer = readFileSync(new URL("packages/desktop/build/installer.nsh", root), "utf8");
  assert.match(installer, /DetailPrint "nekcode:/);
  assert.match(installer, /\$R9\\\.nek/);
  assert.match(installer, /"\.nekcode-install-manifest"/);
  assert.match(config, /"\.nekcode-install-manifest"/);
  assert.doesNotMatch(
    installer,
    /DetailPrint "ZCode:|ZCode-installer\.log|ZCode-uninstaller\.log|\.zcode/,
  );
});
