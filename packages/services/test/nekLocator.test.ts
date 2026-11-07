import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import {
  createNekLocatorDeps,
  NekLocator,
  NekLocatorError,
  parseNekGuiInfo,
  toLocatorCommand,
} from "../src/nek-agent/nekLocator.js";
import type { NekLocatorDeps } from "../src/nek-agent/nekLocator.js";

/**
 * 定位器决定"能不能启动 nek"，错误必须分类清楚：没装（not_found）、协议不兼容
 * （incompatible，提示升级）、执行失败（failed，带 stderr 摘要）。
 */

function guiInfo(overrides: Partial<NekGuiInfo> = {}): NekGuiInfo {
  return {
    protocolVersion: 1,
    nekVersion: "0.4.3",
    piVersion: "1.0.2",
    node: { path: "/usr/bin/node", version: "v24.0.0" },
    launch: { args: ["/opt/nek/cli.js"] },
    agentDir: "/home/u/.nek/agent",
    sessionDir: "/home/u/.nek/agent/sessions",
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
}

interface FakeDeps extends NekLocatorDeps {
  runs: Array<{ file: string; args: string[]; windowsVerbatimArguments: boolean }>;
  files: Map<string, { size: number; mtimeMs: number }>;
  payload: NekGuiInfo | string;
  exitCode: number;
  stderr: string;
}

function createDeps(options: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  files?: string[];
  payload?: NekGuiInfo | string;
  exitCode?: number;
  stderr?: string;
}): FakeDeps {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  for (const path of options.files ?? []) files.set(path, { size: 10, mtimeMs: 1000 });
  const runs: FakeDeps["runs"] = [];
  const deps: FakeDeps = {
    platform: options.platform ?? "linux",
    env: options.env ?? {},
    homedir: "/home/u",
    files,
    runs,
    payload: options.payload ?? guiInfo(),
    exitCode: options.exitCode ?? 0,
    stderr: options.stderr ?? "",
    statFile: async (path) => files.get(path) ?? null,
    run: async (file, args, runOptions) => {
      runs.push({ file, args, windowsVerbatimArguments: runOptions.windowsVerbatimArguments });
      const payload = deps.payload;
      return {
        code: deps.exitCode,
        stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
        stderr: deps.stderr,
      };
    },
  };
  return deps;
}

test("finds nek on PATH (Windows tries .cmd first)", async () => {
  const deps = createDeps({
    platform: "win32",
    env: { PATH: "C:\\Windows;C:\\tools", ComSpec: "C:\\Windows\\cmd.exe" },
    files: ["C:\\tools\\nek.cmd"],
  });
  const locator = new NekLocator(deps);
  const result = await locator.locate();
  assert.equal(result.launcherPath, "C:\\tools\\nek.cmd");
  assert.equal(result.info.nekVersion, "0.4.3");
  // .cmd 必须经 cmd.exe /d /s /c，整条命令行再包一层引号（/s 会去掉它），并原样传递参数。
  assert.equal(deps.runs[0]?.file, "C:\\Windows\\cmd.exe");
  assert.deepEqual(deps.runs[0]?.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(deps.runs[0]?.args[3], '""C:\\tools\\nek.cmd" "gui-info" "--json""');
  assert.equal(deps.runs[0]?.windowsVerbatimArguments, true);
});

test("puts the meaningful stderr line into the failure message", async () => {
  const deps = createDeps({
    env: { PATH: posix.join("/usr", "bin") },
    files: [posix.join("/usr", "bin", "nek")],
    exitCode: 1,
    stderr: [
      "(node:33060) ExperimentalWarning: SQLite is an experimental feature",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "Error: Unknown option: --json",
    ].join("\n"),
  });
  await assert.rejects(new NekLocator(deps).locate(), (error: unknown) => {
    assert.ok(error instanceof NekLocatorError);
    assert.match(error.message, /exited with 1: Error: Unknown option: --json$/u);
    return true;
  });
});

test(
  "runs a real .cmd launcher from a path with spaces through cmd.exe",
  { skip: process.platform !== "win32" && "Windows-only: exercises cmd.exe quoting" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nek locator spaced "));
    try {
      const bin = join(root, "bin dir");
      await mkdir(bin);
      const payloadFile = join(root, "gui info.json");
      await writeFile(payloadFile, JSON.stringify(guiInfo()));
      // 回显参数校验：只有收到 `gui-info --json` 才输出 payload。
      await writeFile(
        join(bin, "nek.cmd"),
        `@echo off\r\nif "%~1"=="gui-info" if "%~2"=="--json" (type "${payloadFile}" & exit /b 0)\r\necho bad args %* 1>&2\r\nexit /b 3\r\n`,
      );
      const deps = { ...createNekLocatorDeps(), env: { ...process.env, PATH: bin } };
      const result = await new NekLocator(deps).locate();
      assert.equal(result.launcherPath, join(bin, "nek.cmd"));
      assert.equal(result.info.nekVersion, "0.4.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("falls back to %LOCALAPPDATA%\\nekcode\\bin\\nek.cmd on Windows", async () => {
  const deps = createDeps({
    platform: "win32",
    env: { PATH: "", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    files: ["C:\\Users\\u\\AppData\\Local\\nekcode\\bin\\nek.cmd"],
  });
  const locator = new NekLocator(deps);
  const result = await locator.locate();
  assert.equal(result.launcherPath, "C:\\Users\\u\\AppData\\Local\\nekcode\\bin\\nek.cmd");
});

test("falls back to ~/.local/bin/nek on POSIX", async () => {
  const launcher = posix.join("/home/u", ".local", "bin", "nek");
  const deps = createDeps({ env: { PATH: posix.join("/usr", "bin") }, files: [launcher] });
  assert.equal((await new NekLocator(deps).locate()).launcherPath, launcher);
});

test("reports not_found when nothing is installed", async () => {
  const deps = createDeps({ env: { PATH: posix.join("/usr", "bin") } });
  const locator = new NekLocator(deps);
  await assert.rejects(locator.locate(), (error: unknown) => {
    assert.ok(error instanceof NekLocatorError);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("a configured path wins and a missing configured path is not_found", async () => {
  const custom = posix.join("/opt", "custom", "nek");
  const present = createDeps({ files: [custom] });
  assert.equal(
    (await new NekLocator(present, { configuredPath: custom }).locate()).launcherPath,
    custom,
  );

  const missingLauncher = posix.join("/nope", "nek");
  const missing = createDeps({ files: [posix.join("/usr", "bin", "nek")] });
  await assert.rejects(
    new NekLocator(missing, { configuredPath: missingLauncher }).locate(),
    (error: unknown) => {
      assert.ok(error instanceof NekLocatorError);
      assert.equal(error.code, "not_found");
      assert.ok(error.message.includes(missingLauncher));
      return true;
    },
  );
});

for (const version of ["0.4.2", "0.4.3-beta.1", "unknown"]) {
  test(`NV-1: protocol v1 is not sufficient for nek ${version}`, async () => {
    const deps = createDeps({
      files: ["/bin/nek"],
      env: { PATH: "/bin" },
      payload: guiInfo({ nekVersion: version }),
    });
    const locator = new NekLocator(deps);
    await assert.rejects(locator.locate(), (error: unknown) => {
      assert.ok(error instanceof NekLocatorError);
      assert.equal(error.code, "incompatible");
      assert.equal(error.detail?.actualNekVersion, version);
      assert.equal(error.detail?.requiredNekVersion, "0.4.3");
      return true;
    });
    deps.payload = guiInfo({ nekVersion: "0.4.10" });
    assert.equal((await locator.locate()).info.nekVersion, "0.4.10");
  });
}

test("rejects an incompatible protocolVersion with both versions", async () => {
  const deps = createDeps({
    env: { PATH: posix.join("/usr", "bin") },
    files: [posix.join("/usr", "bin", "nek")],
    payload: guiInfo({ protocolVersion: 99 }),
  });
  await assert.rejects(new NekLocator(deps).locate(), (error: unknown) => {
    assert.ok(error instanceof NekLocatorError);
    assert.equal(error.code, "incompatible");
    assert.equal(error.detail?.actualProtocolVersion, 99);
    assert.equal(error.detail?.expectedProtocolVersion, 1);
    assert.match(error.message, /update nek/u);
    return true;
  });
});

test("classifies a failing gui-info run as failed with a stderr summary", async () => {
  const deps = createDeps({
    env: { PATH: posix.join("/usr", "bin") },
    files: [posix.join("/usr", "bin", "nek")],
    exitCode: 3,
    stderr: "Error: cannot find module\n  at x\n",
  });
  await assert.rejects(new NekLocator(deps).locate(), (error: unknown) => {
    assert.ok(error instanceof NekLocatorError);
    assert.equal(error.code, "failed");
    assert.match(error.detail?.stderrSummary ?? "", /cannot find module/u);
    return true;
  });
});

test("caches by launcher mtime and re-runs after the binary changes", async () => {
  const launcher = posix.join("/usr", "bin", "nek");
  const deps = createDeps({ env: { PATH: posix.join("/usr", "bin") }, files: [launcher] });
  const locator = new NekLocator(deps);
  await locator.locate();
  assert.equal(deps.runs.length, 1);
  const cached = await locator.locate();
  assert.equal(cached.cached, true);
  assert.equal(deps.runs.length, 1);
  // 升级 nek 会改 mtime：缓存自动失效。
  deps.files.set(launcher, { size: 11, mtimeMs: 2000 });
  const refreshed = await locator.locate();
  assert.equal(refreshed.cached, false);
  assert.equal(deps.runs.length, 2);
});

test("parseNekGuiInfo tolerates installer noise and rejects broken payloads", () => {
  const payload = guiInfo();
  assert.deepEqual(parseNekGuiInfo(`${JSON.stringify(payload)}\n`), payload);
  assert.deepEqual(parseNekGuiInfo(`warning: deprecated\n${JSON.stringify(payload)}`), payload);
  assert.equal(parseNekGuiInfo("not json"), null);
  assert.equal(parseNekGuiInfo(JSON.stringify({ ...payload, launch: {} })), null);
});

test("toLocatorCommand leaves non-shim launchers untouched", () => {
  const launcher = posix.join("/usr", "bin", "nek");
  assert.deepEqual(toLocatorCommand(launcher, ["gui-info", "--json"], "linux"), {
    file: launcher,
    args: ["gui-info", "--json"],
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(toLocatorCommand(launcher, ["gui-info"], "darwin"), {
    file: launcher,
    args: ["gui-info"],
    windowsVerbatimArguments: false,
  });
  // 非 win32 平台即使是 .cmd 也不套 cmd.exe（跨平台测试替身仍然按平台判定）。
  assert.deepEqual(toLocatorCommand(posix.join("/opt", "nek.cmd"), ["gui-info"], "linux"), {
    file: posix.join("/opt", "nek.cmd"),
    args: ["gui-info"],
    windowsVerbatimArguments: false,
  });
});
