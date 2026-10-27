#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Linux x64 远端资源由 prepare:remote-assets 生成，两种桌面包消费同一份归档。
// native-search 归档随仓库分发，准备步骤只做本地解包校验，不需要任何下载源配置。
const localRuntimeScripts = nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : [];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

// 版本串必须在任何消费方读取前落盘。prepare:remote-assets 会把 appVersion 烧进
// bundled-remote-assets 的 manifest，而 electron-builder 的 beforePack/afterPack 用
// context.packager.appInfo.version 校验同一份 manifest；两侧都经 getBuildMetadata()
// 读同一份 build-meta.json。若此处不先刷新，烘焙读到的是上一次构建留下的旧缓存，
// 新增 commit 后校验必然以 Bundled remote appVersion mismatch 失败。
runTimedPnpmScript("prepare:build-meta");

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
} else {
  // CI 已下载独立 Linux producer 的制品，不在两个桌面 job 中重复构建。
  // electron-builder 的 beforePack/afterPack 仍会校验完整随包清单，skip 不能绕过资源检查。
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
