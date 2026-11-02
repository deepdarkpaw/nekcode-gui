#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");

/** Build the formal Windows x64 installer through the existing, verified bundle path. */
export function distWin({ env = process.env, run = runCommand } = {}) {
  const buildEnv = {
    ...env,
    ZCODE_ENV: "production",
    ZCODE_PREVIEW_IDENTITY: "0",
    ZCODE_TARGET_OS: "win",
    ZCODE_TARGET_ARCH: "x64",
    ZCODE_SKIP_REMOTE_ASSETS: "0",
  };
  // Remote manifests include the commit-derived version; refresh even when old assets exist.
  const steps = [
    ["prepare:desktop-runtime"],
    ["build:bootstrap"],
    ["bundle:desktop", "--", "--os", "win", "--arch", "x64", "--skip-prepare", "--skip-build"],
  ];
  for (const args of steps) {
    console.log(`[dist:win] pnpm ${args.join(" ")}`);
    const result = run("pnpm", args, { cwd: workspaceRoot, env: buildEnv });
    if (result.status !== 0) {
      throw new Error(
        `[dist:win] ${args[0]} failed: ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}`,
      );
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  distWin();
}
