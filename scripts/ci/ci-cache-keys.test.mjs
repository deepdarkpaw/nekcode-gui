import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  downloadCacheKey,
  electronBuilderCacheDirectory,
  electronCacheDirectory,
  lockfileFingerprint,
  normalizeRunnerArch,
  readPinnedVersions,
  remoteNodeCacheKey,
  resolveCacheOutputs,
  runnerPlatform,
  toolchainFingerprint,
} from "./ci-cache-keys.mjs";

// 缓存键与缓存目录只由 scripts/ci/ci-cache-keys.mjs 派生，工作流消费它的 $GITHUB_OUTPUT。
// 这里锁住派生规则：平台、runner 架构、目标架构、manifest 版本、pnpm-lock.yaml 摘要、
// Node/pnpm 指纹缺一不可，且目录必须等于 Electron/@electron/get/electron-builder 真实使用的路径。
const root = resolve(import.meta.dirname, "../..");
const toolchain = "node24.14.0-pnpm10.33.2";

test("cache keys separate OS, runner arch, target arch and pinned versions", () => {
  const base = {
    kind: "electron",
    runnerOs: "windows",
    runnerArch: "x64",
    version: "41.0.3",
    toolchain,
  };
  const x64 = downloadCacheKey({ ...base, targetArch: "x64" });
  const arm64 = downloadCacheKey({ ...base, targetArch: "arm64" });
  // Windows x64 runner 上的 arm64 交叉构建必须与原生 x64 分开：Electron zip 按目标架构。
  assert.notEqual(x64, arm64);
  assert.match(arm64, /target-arm64/u);
  for (const segment of [
    "electron",
    "windows",
    "x64",
    "41\\.0\\.3",
    "node24\\.14\\.0",
    "pnpm10\\.33\\.2",
  ])
    assert.match(x64, new RegExp(segment, "u"), segment);
  // 版本、工具链、平台变了键都必须变，否则旧缓存会掩盖升级或跨平台复用。
  assert.notEqual(x64, downloadCacheKey({ ...base, targetArch: "x64", version: "42.0.0" }));
  assert.notEqual(
    x64,
    downloadCacheKey({ ...base, targetArch: "x64", toolchain: "node24.14.0-pnpm11.0.0" }),
  );
  assert.notEqual(x64, downloadCacheKey({ ...base, runnerOs: "macos", targetArch: "x64" }));
  assert.throws(() => downloadCacheKey({ kind: "electron", runnerOs: "windows" }));
});

test("lockfile changes invalidate download keys even when the manifest range is unchanged", () => {
  // 典型场景：manifest 还是 ^26.8.1，lockfile 把它解析成 26.8.2。
  // 只剥 semver 前缀的键会保持不变，从而命中旧工具缓存并跳过保存新的工具链缓存。
  const base = {
    kind: "electron-builder",
    runnerOs: "windows",
    runnerArch: "x64",
    targetArch: "arm64",
    version: "26.8.1",
    toolchain,
  };
  const lockA = lockfileFingerprint("lockfile: electron-builder 26.8.1\n");
  const lockB = lockfileFingerprint("lockfile: electron-builder 26.8.2\n");
  const keyA = downloadCacheKey({ ...base, lockfile: lockA });
  const keyB = downloadCacheKey({ ...base, lockfile: lockB });
  assert.notEqual(keyA, keyB);
  assert.match(keyA, /lock[0-9a-f]{12}$/u);
  // 同一输入必须稳定，否则每次 run 都 miss。
  assert.equal(
    keyA,
    downloadCacheKey({
      ...base,
      lockfile: lockfileFingerprint("lockfile: electron-builder 26.8.1\n"),
    }),
  );
  // 锁文件摘要叠加在原有隔离之上，不能替代平台/目标架构隔离。
  assert.notEqual(keyA, downloadCacheKey({ ...base, targetArch: "x64", lockfile: lockA }));
  assert.notEqual(keyA, downloadCacheKey({ ...base, runnerOs: "macos", lockfile: lockA }));
  assert.throws(() => lockfileFingerprint(""));
});

test("remote node archive key locks platform, version and archive checksum", async () => {
  const { REMOTE_NODE_VERSION, remoteNodeDistribution } =
    await import("../remote-node-runtime.mjs");
  const distribution = remoteNodeDistribution("linux-x64");
  const key = remoteNodeCacheKey({
    platform: "linux-x64",
    version: REMOTE_NODE_VERSION,
    sha256: distribution.sha256,
    toolchain,
  });
  assert.match(key, /node-archive/u);
  assert.ok(key.includes(REMOTE_NODE_VERSION), key);
  // 归档 SHA 前缀进键：内容一变，旧缓存不会被当成新版本；恢复后脚本仍会重算 SHA256。
  assert.ok(key.includes(distribution.sha256.slice(0, 12)), key);
  assert.notEqual(
    key,
    remoteNodeCacheKey({
      platform: "linux-x64",
      version: REMOTE_NODE_VERSION,
      sha256: "0".repeat(64),
      toolchain,
    }),
  );
});

test("download cache directories match the real per-platform locations", async () => {
  const home = join("/", "home", "runner");
  const localAppData = join("C:", "Users", "x", "AppData", "Local");
  // @electron/get 用 env-paths('electron', {suffix:''}).cache，没有可重定向到工作区路径的
  // 环境变量，所以必须缓存对应平台真实使用的目录（Windows 还有一层 Cache）：
  // - darwin: ~/Library/Caches/<name>
  // - win32 : <localAppData>/<name>/Cache
  // - linux : $XDG_CACHE_HOME/<name> 或 ~/.cache/<name>
  assert.equal(
    electronCacheDirectory({ platform: "darwin", home }),
    join(home, "Library", "Caches", "electron"),
  );
  assert.equal(
    electronCacheDirectory({ platform: "linux", home }),
    join(home, ".cache", "electron"),
  );
  assert.equal(
    electronCacheDirectory({ platform: "linux", home, xdgCacheHome: join("/", "xdg") }),
    join("/", "xdg", "electron"),
  );
  assert.equal(
    electronCacheDirectory({ platform: "win32", home, localAppData }),
    join(localAppData, "electron", "Cache"),
  );
  // 期望值不是自说自话：直接核对已安装 env-paths 的 Windows 规则与 @electron/get 的用法。
  const envPathsSource = await readFile(resolve(root, "node_modules/env-paths/index.js"), "utf8");
  assert.match(envPathsSource, /cache: path\.join\(localAppData, name, 'Cache'\)/u);
  const electronGetCache = await readFile(
    resolve(root, "node_modules/@electron/get/dist/cjs/Cache.js"),
    "utf8",
  );
  assert.match(
    electronGetCache,
    /env_paths_1\.default\('electron', \{\s*suffix: '',?\s*\}\)\.cache/u,
  );
  // electron-builder 的 getCacheDirectory 同样在 Windows 多一层 Cache。
  assert.equal(
    electronBuilderCacheDirectory({ platform: "win32", home, localAppData }),
    join(localAppData, "electron-builder", "Cache"),
  );
  assert.equal(
    electronBuilderCacheDirectory({ platform: "darwin", home }),
    join(home, "Library", "Caches", "electron-builder"),
  );
  assert.equal(
    electronBuilderCacheDirectory({ platform: "linux", home }),
    join(home, ".cache", "electron-builder"),
  );
  assert.equal(runnerPlatform("Windows"), "win32");
  assert.equal(runnerPlatform("macOS"), "darwin");
  assert.equal(runnerPlatform("Linux"), "linux");
  assert.equal(normalizeRunnerArch("ARM64"), "arm64");
});

test("pinned versions come from the packaging package and match the builder config", async () => {
  const desktopPackage = JSON.parse(
    await readFile(resolve(root, "packages/desktop/package.json"), "utf8"),
  );
  const pinned = readPinnedVersions(desktopPackage);
  assert.equal(pinned.electron, desktopPackage.devDependencies.electron);
  assert.equal(pinned.playwright, desktopPackage.dependencies["playwright-core"]);
  // 键里只留数字版本：electron-builder 声明的是 ^26.8.1 这类 range。
  assert.match(pinned.electronBuilder, /^[0-9]/u);
  assert.equal(
    pinned.electronBuilder,
    desktopPackage.devDependencies["electron-builder"].replace(/^\^/u, ""),
  );
  // 打包实际使用的 Electron 版本必须与 package.json 一致，否则缓存的是另一份 runtime。
  const builderConfig = await readFile(
    resolve(root, "packages/desktop/electron-builder.config.js"),
    "utf8",
  );
  assert.match(
    builderConfig,
    new RegExp(`electronVersion:\\s*"${pinned.electron.replaceAll(".", "\\.")}"`, "u"),
  );
  assert.throws(() => readPinnedVersions({ dependencies: {}, devDependencies: {} }));
  assert.throws(() => toolchainFingerprint({ nodeVersion: "24.14.0" }));
  assert.equal(
    toolchainFingerprint({ nodeVersion: "24.14.0", packageManager: "pnpm@10.33.2" }),
    toolchain,
  );
});

test("resolved outputs describe this repository for each runner and target arch", async () => {
  const lock = lockfileFingerprint(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const windows = await resolveCacheOutputs({
    root,
    runnerOs: "Windows",
    runnerArch: "X64",
    targetArch: "arm64",
    env: { LOCALAPPDATA: join("C:", "Users", "runner", "AppData", "Local") },
  });
  assert.match(windows.keys.electron, /windows-x64-target-arm64/u);
  assert.match(windows.keys["electron-builder"], /electron-builder-windows-x64-target-arm64/u);
  assert.match(windows.keys.playwright, /playwright-windows-x64/u);
  assert.match(windows.keys["remote-node"], /node-archive-linux-x64/u);
  // 三个依赖 manifest 的下载物都必须带锁文件摘要；远端 Node 归档有自己的 SHA，不需要。
  for (const name of ["electron", "electron-builder", "playwright"])
    assert.ok(windows.keys[name].endsWith(`lock${lock}`), `${name}: ${windows.keys[name]}`);
  assert.doesNotMatch(windows.keys["remote-node"], /lock[0-9a-f]{12}$/u);
  // Windows 的真实 Electron zip 缓存目录：<localAppData>/electron/Cache。
  assert.equal(
    windows.dirs.electron,
    join("C:", "Users", "runner", "AppData", "Local", "electron", "Cache"),
  );
  const linux = await resolveCacheOutputs({ root, runnerOs: "Linux", runnerArch: "X64", env: {} });
  // Playwright 浏览器 = Playwright 版本 + chromium，键里必须体现。
  assert.match(linux.keys.playwright, /playwright-linux-x64-1\.59\.1-chromium/u);
  const macArm = await resolveCacheOutputs({
    root,
    runnerOs: "macOS",
    runnerArch: "ARM64",
    env: { HOME: join("/", "Users", "runner") },
  });
  assert.match(macArm.keys.electron, /macos-arm64-target-arm64/u);
  assert.notEqual(macArm.keys.electron, windows.keys.electron);
});
