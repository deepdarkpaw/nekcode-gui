/**
 * 在隔离环境里启动打包好的 nekcode：临时 HOME / LOCALAPPDATA / Electron userData /
 * nek agentDir，PATH 最前面放一个指向 nek 开发版的启动器，绝不触碰用户真实的 `~/.nek`。
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** 根据当前平台选取唯一打包入口，避免混淆不同 flavor 的陈旧产物。 */
export function defaultExecutable(
  root = resolve("packages/desktop/dist"),
  platform = process.platform,
) {
  const folder =
    platform === "win32" ? "win-unpacked" : platform === "linux" ? "linux-unpacked" : null;
  if (!folder) throw new Error(`pass --app on ${platform}`);
  const directory = join(root, folder);
  const pattern =
    platform === "win32" ? /^nekcode(?:-preview)?\.exe$/iu : /^nekcode(?:-preview)?$/u;
  const matches = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && pattern.test(entry.name),
  );
  if (matches.length !== 1)
    throw new Error(`expected one nekcode executable in ${directory}; found ${matches.length}`);
  return join(directory, matches[0].name);
}

/** 取一个空闲 TCP 端口给 CDP 用。 */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 建隔离目录树。 */
export async function createSandbox(label) {
  const root = await mkdtemp(join(tmpdir(), `nekcode-acceptance-${label}-`));
  // Windows 的 known folder（appData 等）按 %USERPROFILE%\AppData\* 解析，目录不存在时
  // Electron 会在主进程抛 "Failed to get 'appData' path"，所以隔离 HOME 也要带完整布局。
  const dirs = {
    root,
    home: join(root, "home"),
    appData: join(root, "home", "AppData", "Roaming"),
    localAppData: join(root, "home", "AppData", "Local"),
    userData: join(root, "electron-user-data"),
    agentDir: join(root, "nek-agent"),
    bin: join(root, "bin"),
    project: join(root, "project"),
    screenshots: join(root, "screenshots"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await writeFile(join(dirs.project, "README.md"), "# acceptance project\n");
  return dirs;
}

/** 在 sandbox/bin 写 nek 启动器：Windows 是 nek.cmd，其他平台是可执行 sh。 */
export async function writeNekShim(sandbox, nodePath, cliPath) {
  if (process.platform === "win32") {
    await writeFile(join(sandbox.bin, "nek.cmd"), `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`);
    return;
  }
  await writeFile(join(sandbox.bin, "nek"), `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`, {
    mode: 0o755,
  });
}

/** 启动应用；stdout/stderr 写进 sandbox/app.log。extraArgs 仅使用产品已有启动参数。 */
export function launchApp({
  executable,
  sandbox,
  cdpPort,
  extraEnv = {},
  withNekShim,
  extraArgs = [],
}) {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const env = {
    ...process.env,
    USERPROFILE: sandbox.home,
    HOME: sandbox.home,
    APPDATA: sandbox.appData,
    LOCALAPPDATA: sandbox.localAppData,
    NEK_CODING_AGENT_DIR: sandbox.agentDir,
    XDG_CONFIG_HOME: join(sandbox.home, ".config"),
    XDG_DATA_HOME: join(sandbox.home, ".local", "share"),
    XDG_CACHE_HOME: join(sandbox.home, ".cache"),
    PATH: withNekShim ? `${sandbox.bin}${delimiter}${pathValue}` : pathValue,
    ...extraEnv,
  };
  delete env.Path;
  const child = spawn(
    executable,
    [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${sandbox.userData}`, ...extraArgs],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform !== "win32",
    },
  );
  const log = createWriteStream(join(sandbox.root, "app.log"), { flags: "a" });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("error", (error) => log.write(`\n[harness] spawn failed: ${error.message}\n`));
  child.once("exit", (code, signal) => {
    log.end(`\n[harness] app exited code=${code} signal=${signal}\n`);
  });
  return child;
}

/** 结束应用整棵进程树。 */
export function stopApp(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`taskkill failed (${result.status}): ${result.stderr}`);
    }
    return;
  }
  process.kill(-child.pid, "SIGKILL");
}
