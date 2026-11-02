/**
 * 打包应用启动冒烟：隔离环境启动 → renderer 挂载 → 无未捕获异常、无错误边界 → 截图。
 * 不依赖 nek，可在 CI 打包后直接运行。
 *
 * 用法：node scripts/acceptance/packaged-smoke.mjs [--app <可执行文件>] [--keep]
 * 退出码：0 通过；1 失败（原因打印到 stderr，截图与日志留在 sandbox 目录）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createSandbox,
  defaultExecutable,
  freePort,
  launchApp,
  removeSandbox,
  stopApp,
} from "./lib/app.mjs";
import { connectRenderer, evaluate, screenshot, waitForPage } from "./lib/cdp.mjs";

/** renderer 错误边界的固定文案（zh-CN / en-US）。 */
const ERROR_BOUNDARY_PATTERN = "应用界面出了点问题|Something went wrong in the app";
const MOUNTED =
  "document.getElementById('root')?.children.length > 0 && document.body.innerText.trim().length > 20";
const SETTLE_MS = 8_000;

async function runSmoke(executable, sandbox) {
  const cdpPort = await freePort();
  const child = launchApp({ executable, sandbox, cdpPort, withNekShim: false });
  let session;
  try {
    session = await connectRenderer(cdpPort);
    await waitForPage(session, MOUNTED, "renderer mounted", 60_000);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    await screenshot(session, join(sandbox.screenshots, "smoke-home.png"));
    const boundary = await evaluate(
      session,
      `new RegExp(${JSON.stringify(ERROR_BOUNDARY_PATTERN)}).test(document.body.innerText)`,
    );
    const exceptions = session.problems.filter((problem) => problem.kind === "exception");
    const failures = [];
    if (boundary) failures.push("renderer error boundary is showing");
    for (const problem of exceptions) failures.push(`uncaught: ${problem.text.split("\n")[0]}`);
    const log = await readFile(join(sandbox.root, "app.log"), "utf8");
    if (/uncaughtException|MaxListenersExceededWarning/u.test(log)) {
      failures.push("uncaught exception or listener leak in app.log");
    }
    for (const problem of session.problems) {
      if (/MaxListenersExceededWarning/u.test(problem.text)) failures.push(problem.text);
    }
    await writeFile(
      join(sandbox.root, "renderer-problems.json"),
      JSON.stringify(session.problems, null, 2),
    );
    return { failures, warnings: session.problems.filter((p) => p.kind !== "exception") };
  } finally {
    session?.close();
    await stopApp(child);
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
  if (!failed && !values.keep) await removeSandbox(sandbox);
  process.exitCode = failed ? 1 : 0;
}
