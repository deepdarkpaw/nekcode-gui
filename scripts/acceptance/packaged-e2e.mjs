/**
 * 打包应用真实链路验收：隔离 HOME + nek shim + 本地 SSE mock，断言与操作只走 CDP。
 * 用法：node scripts/acceptance/packaged-e2e.mjs [--app <path>] [--keep]
 * NEK_RPC_WORKTREE 指向预构建的 nek 开发版；失败与 blocked 均非通过，并保留全部证据。
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createSandbox,
  defaultExecutable,
  freePort,
  launchApp,
  stopApp,
  writeNekShim,
} from "./lib/app.mjs";
import { connectRenderer, screenshot, waitForPage } from "./lib/cdp.mjs";
import { mockNekConfig, startMockLlm } from "./lib/mockLlm.mjs";
import {
  assertNoRendererFailure,
  clickButton,
  pageText,
  waitForText,
  waitForTextGone,
} from "./lib/ui.mjs";
import { checkSettings } from "./lib/settings-check.mjs";
import {
  checkFirstPrompt,
  checkInteractions,
  checkRestoredSession,
  checkStatus,
  checkStop,
} from "./lib/conversation-check.mjs";

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean", default: false } },
});
const sandbox = await createSandbox("e2e");
const mock = await startMockLlm();
const matrix = [];
const problems = [];
let session;
let app;

async function capture(name) {
  const path = join(sandbox.screenshots, `${name}.png`);
  await screenshot(session, path);
  return path;
}

/** 依赖失败只记 blocked，不把同一张首页截图声称为后续链路证据。 */
async function step(name, action, dependency) {
  if (dependency && matrix.find((row) => row.name === dependency)?.status !== "pass") {
    matrix.push({ name, status: "blocked", error: `depends on ${dependency}` });
    return;
  }
  try {
    await action();
    await assertNoRendererFailure(session);
    matrix.push({ name, status: "pass", screenshot: await capture(name) });
  } catch (error) {
    const row = {
      name,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
    try {
      row.screenshot = await capture(name);
      await writeFile(join(sandbox.root, `${name}.dom.txt`), await pageText(session));
    } catch (captureError) {
      row.evidenceError = String(captureError);
    }
    matrix.push(row);
  }
}

async function launchAndConnect() {
  const port = await freePort();
  app = launchApp({
    executable: values.app ?? defaultExecutable(),
    sandbox,
    cdpPort: port,
    withNekShim: true,
    extraArgs: [`--open-workspace=${sandbox.project}`],
  });
  session = await connectRenderer(port);
  await waitForPage(
    session,
    "document.getElementById('root')?.children.length > 0",
    "renderer mounted",
    60_000,
  );
}

function closeSession() {
  if (session) {
    problems.push(...session.problems);
    session.close();
    session = undefined;
  }
  if (app) {
    stopApp(app);
    app = undefined;
  }
}

try {
  const config = mockNekConfig(mock.baseUrl);
  for (const [file, content] of [
    ["models.json", config.models],
    ["settings.json", config.settings],
  ]) {
    await writeFile(join(sandbox.agentDir, file), `${JSON.stringify(content, null, 2)}\n`);
  }
  await writeNekShim(
    sandbox,
    process.execPath,
    join(
      process.env.NEK_RPC_WORKTREE ?? "G:/coding/nekcode-gui/.worktree/nek-rpc",
      "packages/coding-agent/dist/bundle/cli.js",
    ),
  );
  await launchAndConnect();
  await step("01-onboarding-nek-ready", async () => {
    await waitForText(session, "已安装 nek", "nek detection", 60_000);
  });
  await step(
    "02-onboarding-account",
    async () => {
      await clickButton(session, "下一步");
      await waitForText(session, "已配置服务商", "mock provider");
      if (!(await pageText(session)).includes("mock"))
        throw new Error("mock provider is not listed");
    },
    "01-onboarding-nek-ready",
  );
  await step(
    "03-onboarding-workspace",
    async () => {
      await clickButton(session, "下一步");
      await waitForText(session, "选择本机文件夹", "workspace step");
    },
    "02-onboarding-account",
  );
  await step(
    "04-workspace-ready",
    async () => {
      await clickButton(session, "跳过此步");
      await waitForTextGone(session, "欢迎使用 nekcode", "onboarding closed");
      await waitForText(session, "project", "sandbox workspace");
    },
    "03-onboarding-workspace",
  );
  await step("05-settings-pages", () => checkSettings(session, sandbox), "04-workspace-ready");
  await step(
    "06-prompt-trust-and-run",
    () => checkFirstPrompt(session, sandbox),
    "05-settings-pages",
  );
  await step("07-status-and-usage", () => checkStatus(session), "06-prompt-trust-and-run");
  await step(
    "08-structured-interactions",
    () => checkInteractions(session, sandbox, mock),
    "06-prompt-trust-and-run",
  );
  await step(
    "09-session-resume",
    async () => {
      closeSession();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await launchAndConnect();
      await checkRestoredSession(session);
    },
    "08-structured-interactions",
  );
  await step("10-stop-running", () => checkStop(session, mock), "09-session-resume");
} catch (error) {
  matrix.push({ name: "harness", status: "fail", error: String(error) });
} finally {
  try {
    closeSession();
  } catch (error) {
    matrix.push({ name: "app-cleanup", status: "fail", error: String(error) });
  }
  await mock.close();
  const log = await readFile(join(sandbox.root, "app.log"), "utf8");
  if (/uncaughtException|MaxListenersExceededWarning/u.test(log)) {
    matrix.push({
      name: "app-log",
      status: "fail",
      error: "uncaught exception or listener leak in app.log",
    });
  }
  await writeFile(join(sandbox.root, "mock-requests.json"), JSON.stringify(mock.requests, null, 2));
  await writeFile(join(sandbox.root, "renderer-problems.json"), JSON.stringify(problems, null, 2));
  await writeFile(join(sandbox.root, "matrix.json"), JSON.stringify(matrix, null, 2));
  for (const row of matrix)
    console.log(`${row.name}: ${row.status}${row.error ? ` — ${row.error}` : ""}`);
  console.log(`sandbox: ${sandbox.root}`);
  const failed = matrix.length === 0 || matrix.some((row) => row.status !== "pass");
  if (!failed && !values.keep) await rm(sandbox.root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
