import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * nekcode 版本串的唯一派生实现。
 *
 * 规则：
 * - 正式版：HEAD 带 `v<基线>` tag（`pnpm release` 打的发版 tag）时，版本串就是基线，
 *   例 `0.1.0`，安装包名为 `nekcode-0.1.0-win-x64.exe`；
 * - 其他构建是滚动串 `<nekcode 基线>-<YYYYMMDD>.<commitCount>`，例 `0.1.0-20261102.400`；
 * - 基线由根 package.json 的 version 管理，从 nekcode 自己的 0.1.0 起步，不跟随 ZCodium；
 * - 日期段取 commit 的 committer date（UTC），commitCount 取 `git rev-list --count HEAD`：
 *   版本串是 commit 的纯函数，同一 commit 在任意时间、任意 CI job 派生结果一致。
 *   electron-builder beforePack 的 bundled-remote manifest 相等校验、desktop-release collect
 *   的产物名匹配、mock-cdn releases 目录名都依赖这一点；
 * - 单调性全部由破折号后的 prerelease 段承担；`+` build metadata 被 semver 优先级忽略，禁用；
 * - 浅克隆里 rev-list 只见 graft 出的少量 commit，count 不是全史序号，同一天不同 commit 会
 *   撞号；CI 必须 fetch-depth: 0，这里显式告警，不静默产出撞号版本。
 *
 * 本文件位于仓库根 scripts/，桌面、server、web 的构建配置都经此读取，不存在第二条版本来源。
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(scriptDir, "..");

/** 共享发布语法；CI 安装依赖前也要能验证版本。 */
export const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const NUMERIC_PATTERN = /^\d+$/;

/** 滚动版本串：`<nekcode 基线>-<YYYYMMDD>.<commitCount>`。 */
export function formatRollingAppVersion(baseline, buildDate, commitCount) {
  return `${baseline}${baseline.includes("-") ? "." : "-"}${buildDate}.${commitCount}`;
}

/** 正式版 tag 名：`v<基线>`。 */
export function releaseTagName(baseline) {
  return `v${baseline}`;
}

/**
 * 版本串派生（纯函数）：HEAD 带 `v<基线>` tag 时是正式版，版本串就是基线；
 * 否则是滚动串。tag 名与基线不一致（如手打的 `v9.9.9`）不算正式版。
 */
export function resolveAppVersion({ baseline, headTags, buildDate, commitCount }) {
  if (headTags.includes(releaseTagName(baseline))) {
    return { appVersion: baseline, isRelease: true };
  }
  return {
    appVersion: formatRollingAppVersion(baseline, buildDate, commitCount),
    isRelease: false,
  };
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

function resolveUpstreamBaseline() {
  const rootPackageJson = JSON.parse(readFileSync(resolve(workspaceDir, "package.json"), "utf-8"));
  const normalized = normalizeVersion(rootPackageJson.version);
  // 错误版本必须阻断构建，不能静默变成 0.0.0；beta 与稳定版共用同一语法。
  if (!RELEASE_VERSION_PATTERN.test(normalized))
    throw new Error(`Invalid release baseline: ${normalized}`);
  return normalized;
}

function resolveUtcBuildDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 日期段取 commit 的 committer date（UTC），不取构建时刻：同一 commit 在任意时间、任意 CI job
 * （remote-assets / build / collect）派生出的版本串必须一致；跨 UTC 日的两次构建也不能漂移。
 */
function resolveCommitBuildDate() {
  try {
    const commitDate = execSync("git log -1 --format=%cI", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const utcDate = new Date(commitDate).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) {
      return utcDate.replace(/-/g, "");
    }
  } catch {
    // 非 git 检出（源码 tar 包等）时回退构建日
  }

  return resolveUtcBuildDate();
}

function isShallowRepository() {
  try {
    return (
      execSync("git rev-parse --is-shallow-repository", {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true"
    );
  } catch {
    return false;
  }
}

function resolveCommitCount() {
  try {
    const output = execSync("git rev-list --count HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (NUMERIC_PATTERN.test(output)) {
      if (isShallowRepository()) {
        // 浅克隆（actions/checkout 默认 depth=1）里 rev-list 只见 graft 出来的少量 commit，
        // count 不是全史序号：同一天不同 commit 会派生相同版本串，updater 漏推更新。
        // CI 必须 fetch-depth: 0；这里显式告警，避免静默产出撞号版本。
        console.warn(
          `[rolling-version] shallow checkout: commitCount=${output} is not the full history count; CI must use fetch-depth: 0`,
        );
      }
      return output;
    }
  } catch {
    // 非 git 检出（源码 tar 包等）时走环境变量回退
  }

  const fromEnv = process.env.ZCODE_COMMIT_COUNT?.trim();
  return fromEnv && NUMERIC_PATTERN.test(fromEnv) ? fromEnv : "0";
}

/** HEAD 上的 tag 列表；CI 必须 fetch-depth: 0 才会检出 tag。 */
function resolveHeadTags() {
  try {
    return execSync("git tag --points-at HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    // 非 git 检出（源码 tar 包等）没有 tag，按滚动版本构建
    return [];
  }
}

/**
 * 桌面 / server / web 构建配置的统一入口：一次取出版本串、nekcode 基线与是否正式版。
 * （函数名沿用历史的 rolling：日常构建仍是滚动串，只有发版 tag 上是基线。）
 */
export function collectRollingAppVersion() {
  const upstreamBaseline = resolveUpstreamBaseline();
  const { appVersion, isRelease } = resolveAppVersion({
    baseline: upstreamBaseline,
    headTags: resolveHeadTags(),
    buildDate: resolveCommitBuildDate(),
    commitCount: resolveCommitCount(),
  });
  return { appVersion, upstreamBaseline, isRelease };
}
