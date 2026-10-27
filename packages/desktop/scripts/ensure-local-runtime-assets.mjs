#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  resolveNativeSearchBuildPlan,
  resolveNativeSearchReleasePlan,
} from "../../../scripts/native-search-tools-config.mjs";
import { verifyBuiltNativeSearchTools } from "../../../scripts/native-search-tools-verify.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const target = getTargetPlatform();
const bundledToolsRoot = join(desktopRoot, "bundled-tools", target.key);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
const nativeSearchBuildPlan = nativeSearchReleasePlan.enabled
  ? resolveNativeSearchBuildPlan({
      platform: target.os,
      arch: target.arch,
      outputDir: bundledToolsRoot,
    })
  : undefined;

function isNativeSearchReady() {
  if (!nativeSearchBuildPlan) return true;
  const requiredPaths = nativeSearchReleasePlan.runtimeToolIds.map(
    (toolId) => nativeSearchBuildPlan.binaries[toolId],
  );
  if (requiredPaths.some((binaryPath) => !binaryPath || !existsSync(binaryPath))) {
    return false;
  }

  try {
    verifyBuiltNativeSearchTools({
      bfsPath: nativeSearchBuildPlan.bfsPath,
      rgPath: nativeSearchBuildPlan.rgPath,
      ugrepPath: nativeSearchBuildPlan.ugrepPath,
      platform: nativeSearchBuildPlan.platform,
      arch: nativeSearchBuildPlan.arch,
    });
    return true;
  } catch (error) {
    // native sidecar 不进 Git，切分支后可能留下版本、架构或 ABI 已过期的文件。
    // 复用正式构建 verifier 判定 ready，避免仅凭路径存在继续运行旧产物。
    console.warn(
      `[ensure-local-runtime-assets] embedded search validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // ABI 或功能合同校验失败时清除生成物，确保下一次 prepare 从仓库归档重新解压。
    for (const binaryPath of requiredPaths) {
      rmSync(binaryPath, { force: true });
    }
    return false;
  }
}

const REQUIRED_LOCAL_RUNTIME_ASSETS = nativeSearchReleasePlan.enabled
  ? [
      {
        label: "embedded search",
        script: "prepare:native-search",
        isReady: isNativeSearchReady,
      },
    ]
  : [];

const missingAssets = [];
for (const asset of REQUIRED_LOCAL_RUNTIME_ASSETS) {
  if (!(await asset.isReady())) {
    missingAssets.push(asset);
  }
}

if (missingAssets.length === 0) {
  console.log(`[ensure-local-runtime-assets] all local runtime assets are ready for ${target.key}`);
  process.exit(0);
}

// 开发态需要在 Electron 启动前发现缺失的本地 sidecar/helper，而不是等到真正使用时才报错。
// 这里在 Electron 启动前只自检当前开发路径需要的 embedded search sidecar 和平台 helper。
for (const asset of missingAssets) {
  console.log(
    `[ensure-local-runtime-assets] preparing ${asset.label} because local runtime asset is missing or incomplete`,
  );
  runCommand(pnpmCommand, [asset.script], {
    cwd: desktopRoot,
    env: process.env,
  });
}
