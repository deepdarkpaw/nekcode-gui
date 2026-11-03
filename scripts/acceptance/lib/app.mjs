/**
 * 在隔离环境里启动打包好的 nekcode：临时 HOME / LOCALAPPDATA / Electron userData /
 * nek agentDir，PATH 最前面放一个指向 nek 开发版的启动器，绝不触碰用户真实的 `~/.nek`。
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** 应用与 nek CLI 共用的隔离环境：HOME、known folder 与 nek agentDir 都指向沙箱。 */
function sandboxEnv(sandbox, withNekShim = false) {
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
  };
  delete env.Path;
  return env;
}

/** CLI 输出只保留末尾这么多字符，用于断言与错误信息。 */
const CLI_OUTPUT_LIMIT = 64 * 1024;

/**
 * 在沙箱项目里用 print 模式跑一次 nek CLI，模拟用户在终端里用 nek；返回 stdout。
 * mock 与本进程共用事件循环，必须异步等待（spawnSync 会让 mock 无法响应）；
 * print 模式在 stdin 不是终端时会读到 EOF 才执行，所以 stdin 必须是 ignore。
 */
export async function runNekCli(sandbox, cliPath, prompt, timeoutMs = 60_000) {
  const child = spawn(process.execPath, [cliPath, "-p", prompt], {
    cwd: sandbox.project,
    env: sandboxEnv(sandbox),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = { stdout: "", stderr: "" };
  const keep = (key) => (part) => {
    output[key] = (output[key] + part).slice(-CLI_OUTPUT_LIMIT);
  };
  child.stdout.on("data", keep("stdout"));
  child.stderr.on("data", keep("stderr"));
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`nek CLI did not finish within ${timeoutMs}ms: ${output.stderr.trim()}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (status !== 0) throw new Error(`nek CLI exited with ${status}: ${output.stderr.trim()}`);
  return output.stdout;
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
  const env = { ...sandboxEnv(sandbox, withNekShim), ...extraEnv };
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

/** 结束进程树后等待主进程退出的上限；超时说明进程没被结束，直接报错。 */
const APP_EXIT_TIMEOUT_MS = 15_000;
/**
 * 删除沙箱时的有界重试：Windows 上进程退出后，子进程持有的文件句柄（如 SQLite）
 * 释放有延迟，立即删除会 EBUSY。fs.rm 对 EBUSY/EPERM 等按线性退避重试，用尽仍失败则抛出。
 */
const SANDBOX_RM_RETRIES = 10;
const SANDBOX_RM_RETRY_DELAY_MS = 200;

/** 等待子进程 exit 事件；超时抛错。 */
async function waitForExit(exited, pid) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`app pid ${pid} did not exit within ${APP_EXIT_TIMEOUT_MS}ms`)),
      APP_EXIT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 结束应用整棵进程树，并等主进程真正退出后再返回（taskkill/SIGKILL 只是发出结束请求）。 */
export async function stopApp(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`taskkill failed (${result.status}): ${result.stderr}`);
    }
  } else {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitForExit(exited, child.pid);
}

/** 删除沙箱目录（应用须已由 stopApp 结束）。 */
export async function removeSandbox(sandbox) {
  await rm(sandbox.root, {
    recursive: true,
    force: true,
    maxRetries: SANDBOX_RM_RETRIES,
    retryDelay: SANDBOX_RM_RETRY_DELAY_MS,
  });
}
