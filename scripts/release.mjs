#!/usr/bin/env node
/**
 * 发布新版本：`pnpm release <x.y.z> [--no-push]`
 *
 * 1. 校验：版本是 x.y.z 且不低于当前版本；位于 main、工作区干净、与 origin/main 同步；tag 不存在。
 * 2. 版本有变化时改根 package.json 并重生成三方声明（根包版本写在清单里），提交 `chore(release): v<x>`；
 *    与当前版本相同（例如首个版本）时不提交，直接给 HEAD 打 tag。
 * 3. 打 annotated tag `v<x>`，默认把 main 与 tag 原子推送到 origin。
 *
 * tag 推送后由 Desktop CI 打包，并把安装包发布到 GitHub Releases。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseTagName } from "./rolling-app-version.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJsonPath = resolve(root, "package.json");
const RELEASE_BRANCH = "main";
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_FILES = ["package.json", "THIRD-PARTY-NOTICES.md", "third-party/inventory.json"];

/** 解析命令行：版本号必填，`--no-push` 只在本地提交与打 tag。 */
export function parseReleaseArgs(argv) {
  const push = !argv.includes("--no-push");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = argv.filter((arg) => arg.startsWith("--") && arg !== "--no-push");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(" ")}`);
  if (positional.length !== 1) throw new Error("Usage: pnpm release <x.y.z> [--no-push]");
  const version = positional[0].replace(/^v/, "");
  if (!VERSION_PATTERN.test(version))
    throw new Error(`Version must be x.y.z, got ${positional[0]}`);
  return { version, push };
}

/** 比较两个 x.y.z 版本：负数表示 a 更旧。 */
export function compareVersions(a, b) {
  const left = a.match(VERSION_PATTERN)?.slice(1).map(Number);
  const right = b.match(VERSION_PATTERN)?.slice(1).map(Number);
  if (!left || !right) throw new Error(`Cannot compare versions ${a} and ${b}`);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** 决定是否需要提交版本号变更；不允许发布比当前更旧的版本。 */
export function planRelease({ current, target }) {
  const order = compareVersions(target, current);
  if (order < 0) throw new Error(`Version ${target} is older than the current ${current}`);
  // tag 名与构建侧判定正式版用的是同一个函数：tag 打在哪个 commit，那个 commit 就构建成正式版。
  return { bump: order > 0, tag: releaseTagName(target) };
}

/** 读取 git 输出。 */
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** 运行命令并把输出直接给用户看（耗时步骤，如重生成声明、推送）。 */
function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function assertReleasableCheckout(tag) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== RELEASE_BRANCH) throw new Error(`Release from ${RELEASE_BRANCH}, not ${branch}`);
  if (git(["status", "--porcelain"]) !== "") throw new Error("Working tree is not clean");
  git(["fetch", "--quiet", "origin", RELEASE_BRANCH]);
  if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", `origin/${RELEASE_BRANCH}`])) {
    throw new Error(`HEAD is not the same commit as origin/${RELEASE_BRANCH}; pull or push first`);
  }
  if (git(["tag", "--list", tag]) !== "") throw new Error(`Tag ${tag} already exists locally`);
  if (git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "") {
    throw new Error(`Tag ${tag} already exists on origin`);
  }
}

function bumpVersion(version) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  manifest.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // 根包版本写在三方清单里，改版本后必须重生成，否则 licenses check 会失败。
  run("node", ["scripts/licenses.mjs", "notices"]);
  git(["add", ...RELEASE_FILES]);
  git(["commit", "-m", `chore(release): v${version}`]);
}

function main() {
  const { version, push } = parseReleaseArgs(process.argv.slice(2));
  const current = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  const { bump, tag } = planRelease({ current, target: version });
  assertReleasableCheckout(tag);
  if (bump) bumpVersion(version);
  git(["tag", "-a", tag, "-m", `nekcode ${tag}`]);
  const pushArgs = ["push", "--atomic", "origin", RELEASE_BRANCH, `refs/tags/${tag}`];
  if (!push) {
    console.log(`Tagged ${tag} locally. Publish with: git ${pushArgs.join(" ")}`);
    return;
  }
  run("git", pushArgs);
  console.log(
    `Pushed ${tag}; Desktop CI will build the installers and publish the GitHub Release.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
