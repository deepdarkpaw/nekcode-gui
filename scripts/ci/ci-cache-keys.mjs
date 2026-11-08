import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REMOTE_NODE_VERSION, remoteNodeDistribution } from "../remote-node-runtime.mjs";

// 下载类缓存（Playwright 浏览器、Electron runtime zip、electron-builder 工具链、
// 远端 Node 归档）的键与目录只在这里派生：工作流消费 `$GITHUB_OUTPUT`，不各自拼版本串。
// 键锁住平台、runner 架构、目标架构与真实版本，避免跨架构或跨版本复用二进制；
// 这些缓存只装可下载的输入，不装 node_modules、构建产物或发布资产。

/** 缓存键 schema 版本：键格式或路径语义变化时递增，旧条目自然失效。 */
export const CACHE_KEY_SCHEMA = "v1";

/** 各平台 `env-paths(name).cache` 的根目录；Windows 缺 LOCALAPPDATA 时退回 home。 */
function platformCacheRoot({ platform, home, localAppData, xdgCacheHome }) {
  if (platform === "win32") return localAppData ?? join(home, "AppData", "Local");
  if (platform === "darwin") return join(home, "Library", "Caches");
  return xdgCacheHome ?? join(home, ".cache");
}

/** Electron runtime zip 走 `@electron/get`，其缓存根是 env-paths('electron').cache。 */
export function electronCacheDirectory({ platform, home, localAppData, xdgCacheHome }) {
  return join(platformCacheRoot({ platform, home, localAppData, xdgCacheHome }), "electron");
}

/** electron-builder 的 nsis/winCodeSign 等工具链缓存，`ELECTRON_BUILDER_CACHE` 可显式覆盖。 */
export function electronBuilderCacheDirectory({ platform, home, localAppData, xdgCacheHome }) {
  const root = platformCacheRoot({ platform, home, localAppData, xdgCacheHome });
  // 与 app-builder-lib 的 getCacheDirectory 一致：Windows 多一层 Cache。
  return platform === "win32"
    ? join(root, "electron-builder", "Cache")
    : join(root, "electron-builder");
}

/** 把 Actions 的 RUNNER_OS 归一成 Node 的 process.platform 命名。 */
export function runnerPlatform(runnerOs, nodePlatform = process.platform) {
  const os = String(runnerOs ?? "").toLowerCase();
  if (os === "windows" || os === "win32") return "win32";
  if (os === "macos" || os === "darwin") return "darwin";
  if (os === "linux") return "linux";
  return nodePlatform;
}

/** Actions 的 RUNNER_ARCH 是 X64/ARM64；统一成小写，避免键大小写漂移。 */
export function normalizeRunnerArch(runnerArch, nodeArch = process.arch) {
  return String(runnerArch ?? nodeArch).toLowerCase();
}

/** 从 `packages/desktop/package.json` 读打包工具的钉死版本（Electron/electron-builder/Playwright）。 */
export function readPinnedVersions(desktopPackage) {
  const { dependencies = {}, devDependencies = {} } = desktopPackage;
  const pick = (field, name) => {
    const value = field?.[name];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`missing pinned version: ${name}`);
    // 去掉 semver range 前缀（electron-builder 是 ^26.8.1），键里只留可比较版本。
    return value.replace(/^[^0-9]*/u, "");
  };
  return {
    electron: pick(devDependencies, "electron"),
    electronBuilder: pick(devDependencies, "electron-builder"),
    playwright: pick(dependencies, "playwright-core"),
  };
}

/** 工具链成分：Node 与 pnpm 版本一起进键，镜像/包管理器切换不会被旧缓存掩盖。 */
export function toolchainFingerprint({ nodeVersion, packageManager }) {
  const pnpm = /\bpnpm@([0-9][^+\s]*)/u.exec(packageManager ?? "")?.[1];
  if (!nodeVersion?.trim() || !pnpm) throw new Error("missing node/pnpm version for cache key");
  return `node${nodeVersion.trim()}-pnpm${pnpm}`;
}

/**
 * 按目标下载物派生缓存键。
 * @param {object} spec
 * @param {string} spec.kind 下载物类别（electron / electron-builder / playwright / node-archive）
 * @param {string} spec.runnerOs Runner 操作系统
 * @param {string} spec.runnerArch Runner CPU 架构
 * @param {string} [spec.targetArch] 打包目标架构；与 runner 不同时写进键，跨架构不复用
 * @param {string} spec.version 下载物真实版本（或归档 SHA 前缀）
 * @param {string} spec.toolchain Node/pnpm 指纹
 */
export function downloadCacheKey({ kind, runnerOs, runnerArch, targetArch, version, toolchain }) {
  if (!kind || !runnerOs || !runnerArch || !version || !toolchain)
    throw new Error(`incomplete cache key spec: ${JSON.stringify({ kind, runnerOs, runnerArch })}`);
  const segments = [CACHE_KEY_SCHEMA, kind, runnerOs.toLowerCase(), runnerArch.toLowerCase()];
  if (targetArch) segments.push(`target-${targetArch.toLowerCase()}`);
  segments.push(version, toolchain);
  return segments.join("-");
}

/** 远端 Node 归档：platform 已含架构（linux-x64），版本与归档 SHA 一起锁住内容。 */
export function remoteNodeCacheKey({ platform, version, sha256, toolchain }) {
  return downloadCacheKey({
    kind: "node-archive",
    runnerOs: platform,
    runnerArch: "archive",
    version: `${version}-${sha256.slice(0, 12)}`,
    toolchain,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** 汇总各 job 需要的缓存键与目录；工作流只取自己那几项。 */
export async function resolveCacheOutputs({
  root,
  runnerOs,
  runnerArch,
  targetArch,
  env = process.env,
}) {
  const [rootPackage, desktopPackage, nvmrc] = await Promise.all([
    readJson(join(root, "package.json")),
    readJson(join(root, "packages", "desktop", "package.json")),
    readFile(join(root, ".nvmrc"), "utf8"),
  ]);
  const pinned = readPinnedVersions(desktopPackage);
  const toolchain = toolchainFingerprint({
    nodeVersion: nvmrc,
    packageManager: rootPackage.packageManager,
  });
  const arch = normalizeRunnerArch(runnerArch);
  const target = normalizeRunnerArch(targetArch ?? runnerArch);
  const platformDirs = {
    platform: runnerPlatform(runnerOs),
    home: homedir(),
    localAppData: env.LOCALAPPDATA,
    xdgCacheHome: env.XDG_CACHE_HOME,
  };
  const base = { runnerOs: String(runnerOs), runnerArch: arch, toolchain };
  return {
    keys: {
      electron: downloadCacheKey({
        ...base,
        kind: "electron",
        targetArch: target,
        version: pinned.electron,
      }),
      "electron-builder": downloadCacheKey({
        ...base,
        kind: "electron-builder",
        targetArch: target,
        version: pinned.electronBuilder,
      }),
      playwright: downloadCacheKey({
        ...base,
        kind: "playwright",
        version: `${pinned.playwright}-chromium`,
      }),
      "remote-node": remoteNodeCacheKey({
        platform: "linux-x64",
        version: REMOTE_NODE_VERSION,
        sha256: remoteNodeDistribution("linux-x64").sha256,
        toolchain,
      }),
    },
    dirs: {
      electron: electronCacheDirectory(platformDirs),
      "electron-builder": electronBuilderCacheDirectory(platformDirs),
    },
  };
}

/** 写 `$GITHUB_OUTPUT`：工作流用 steps.<id>.outputs.<name> 消费，不重复解析版本。 */
export async function writeGithubOutputs(outputs, outputPath) {
  const lines = [
    ...Object.entries(outputs.keys).map(([name, value]) => `${name}-key=${value}`),
    ...Object.entries(outputs.dirs).map(([name, value]) => `${name}-dir=${value}`),
  ];
  await appendFile(outputPath, `${lines.join("\n")}\n`);
  return lines;
}

async function main() {
  const targetArchIndex = process.argv.indexOf("--target-arch");
  const targetArch = targetArchIndex >= 0 ? process.argv[targetArchIndex + 1] : undefined;
  const outputs = await resolveCacheOutputs({
    root: resolve(import.meta.dirname, "../.."),
    runnerOs: process.env.RUNNER_OS ?? "Linux",
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    targetArch,
  });
  if (process.env.GITHUB_OUTPUT) await writeGithubOutputs(outputs, process.env.GITHUB_OUTPUT);
  else process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
