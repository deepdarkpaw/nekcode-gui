/**
 * 打包应用启动冒烟：隔离环境启动 → renderer 挂载 → 无未捕获异常、无错误边界 → 截图。
 * 不依赖 nek，可在 CI 打包后直接运行。
 *
 * 用法：node scripts/acceptance/packaged-smoke.mjs [--app <可执行文件>] [--keep]
 * 退出码：0 通过；1 失败（原因打印到 stderr，截图与日志留在 sandbox 目录）。
 */
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, freePort, launchApp, stopApp } from "./lib/app.mjs";
import { connectRenderer, evaluate, screenshot, waitForPage } from "./lib/cdp.mjs";

/** renderer 错误边界的固定文案（zh-CN / en-US）。 */
const ERROR_BOUNDARY_PATTERN = "应用界面出了点问题|Something went wrong in the app";
const MOUNTED =
  "document.getElementById('root')?.children.length > 0 && document.body.innerText.trim().length > 20";
const SETTLE_MS = 8_000;

function defaultExecutable() {
  const root = resolve("packages/desktop/dist");
  if (process.platform === "win32") {
    const dir = join(root, "win-unpacked");
    const exe = readdirSync(dir).find((name) => /^nekcode.*\.exe$/iu.test(name));
    if (!exe) throw new Error(`no nekcode executable in ${dir}`);
    return join(dir, exe);
  }
  if (process.platform === "linux") {
    const dir = join(root, "linux-unpacked");
    const bin = readdirSync(dir).find((name) => /^nekcode/iu.test(name));
    if (!bin) throw new Error(`no nekcode binary in ${dir}`);
    return join(dir, bin);
  }
  throw new Error(`pass --app on ${process.platform}`);
}

async function runSmoke(executable, sandbox) {
  const cdpPort = await freePort();
  const child = launchApp({ executable, sandbox, cdpPort, withNekShim: false });
  try {
    const session = await connectRenderer(cdpPort);
    await waitForPage(session, MOUNTED, "renderer mounted", 60_000);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    await screenshot(session, join(sandbox.screenshots, "smoke-home.png"));
    const boundary = await evaluate(
      session,
      `new RegExp(${JSON.stringify(ERROR_BOUNDARY_PATTERN)}).test(document.body.innerText)`,
    );
    const exceptions = session.problems.filter((problem) => problem.kind === "exception");
    session.close();
    const failures = [];
    if (boundary) failures.push("renderer error boundary is showing");
    for (const problem of exceptions) failures.push(`uncaught: ${problem.text.split("\n")[0]}`);
    return { failures, warnings: session.problems.filter((p) => p.kind !== "exception") };
  } finally {
    stopApp(child);
  }
}

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean", default: false } },
});
const executable = values.app ?? defaultExecutable();
const sandbox = await createSandbox("smoke");
let failed = true;
try {
  const { failures, warnings } = await runSmoke(executable, sandbox);
  for (const warning of warnings)
    console.log(`[smoke] ${warning.kind}: ${warning.text.split("\n")[0]}`);
  for (const failure of failures) console.error(`[smoke] FAIL ${failure}`);
  failed = failures.length > 0;
  console.log(`[smoke] ${failed ? "FAILED" : "passed"}; artifacts: ${sandbox.root}`);
} catch (error) {
  console.error(`[smoke] FAIL ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[smoke] artifacts: ${sandbox.root}`);
} finally {
  if (!failed && !values.keep) await rm(sandbox.root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
