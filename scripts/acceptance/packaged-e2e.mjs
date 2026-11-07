/**
 * 打包应用真实链路验收：隔离 HOME + nek shim + 本地 SSE mock，断言与操作只走 CDP。
 * 用法：node scripts/acceptance/packaged-e2e.mjs [--app <path>] [--keep]
 * NEK_RPC_WORKTREE 指向预构建的 nek 开发版；失败与 blocked 均非通过，并保留全部证据。
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
  runNekCli,
  stopApp,
  writeNekShim,
} from "./lib/app.mjs";
import { connectRenderer, evaluate, screenshot, waitForPage } from "./lib/cdp.mjs";
import { MOCK_CLI_PROMPT, MOCK_CLI_REPLY, mockNekConfig, startMockLlm } from "./lib/mockLlm.mjs";
import {
  assertNoRendererFailure,
  clickButton,
  pageText,
  waitForText,
  waitForTextGone,
} from "./lib/ui.mjs";
import { checkSettings } from "./lib/settings-check.mjs";
import {
  checkAcceptedAnswers,
  checkFileFlow,
  checkFileSummary,
  checkQueuedMessage,
} from "./lib/tool-flow-check.mjs";
import {
  checkFirstPrompt,
  checkInteractions,
  checkPastedImage,
  checkRestoredSession,
  checkStatus,
  checkStop,
} from "./lib/conversation-check.mjs";

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean", default: false } },
});
const sandbox = await createSandbox("e2e");
const mock = await startMockLlm({ projectPath: sandbox.project, slowChunks: 80, slowDelayMs: 100 });
const nekCli = join(
  process.env.NEK_RPC_WORKTREE ?? "G:/coding/nekcode-gui/.worktree/nek-rpc",
  "packages/coding-agent/dist/bundle/cli.js",
);
const matrix = [];
const problems = [];
let session;
let app;

async function capture(name) {
  const path = join(sandbox.screenshots, `${name}.png`);
  await waitForPage(
    session,
    `document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)`,
    "finite UI animations settled",
    10_000,
  );
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
    const measuredSession = session;
    const before = await evaluate(session, "window.__acceptancePerf.commits");
    await action();
    await assertNoRendererFailure(session);
    const perf = await evaluate(session, "window.__acceptancePerf");
    matrix.push({
      name,
      status: "pass",
      screenshot: await capture(name),
      metrics: {
        commits: perf.commits - (session === measuredSession ? before : 0),
        maxMountedNodes: perf.maxMountedNodes,
      },
    });
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
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    window.__acceptancePerf = { commits: 0, maxMountedNodes: 0 };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: () => {
        window.__acceptancePerf.commits++;
        window.__acceptancePerf.maxMountedNodes = Math.max(window.__acceptancePerf.maxMountedNodes, document.querySelectorAll('*').length);
      },
      onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    };
  `,
  });
  await session.send("Page.reload", { ignoreCache: true });
  await waitForPage(
    session,
    "document.getElementById('root')?.children.length > 0",
    "renderer mounted",
    60_000,
  );
}

async function closeSession() {
  if (session) {
    problems.push(...session.problems);
    session.close();
    session = undefined;
  }
  if (app) {
    const stopping = app;
    app = undefined;
    await stopApp(stopping);
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
  await writeNekShim(sandbox, process.execPath, nekCli);
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
    async () => {
      await checkInteractions(session, sandbox, mock);
      await checkAcceptedAnswers(session);
    },
    "06-prompt-trust-and-run",
  );
  await step(
    "08b-file-flow",
    () => checkFileFlow(session, sandbox, mock),
    "08-structured-interactions",
  );
  await step("08c-queued-input", () => checkQueuedMessage(session), "08b-file-flow");
  await step(
    "09-session-resume",
    async () => {
      await closeSession();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await launchAndConnect();
      await checkRestoredSession(session);
      await checkAcceptedAnswers(session);
      await capture("09-answers-restored");
      await checkFileSummary(session);
      await waitForTextGone(session, "已排队，等待当前步骤结束");
    },
    "08c-queued-input",
  );
  await step("10-stop-running", () => checkStop(session, mock), "09-session-resume");
  await step(
    "11-cli-session-sidebar",
    async () => {
      // 用户在终端里用 nek 建了会话再切回 GUI：窗口获得焦点后侧栏要列出它，不用重启。
      const output = await runNekCli(sandbox, nekCli, MOCK_CLI_PROMPT);
      if (!output.includes(MOCK_CLI_REPLY)) throw new Error(`nek CLI answered: ${output.trim()}`);
      await waitForPage(
        session,
        `(window.dispatchEvent(new Event("focus")),
          document.body.innerText.includes(${JSON.stringify(MOCK_CLI_PROMPT)}))`,
        "CLI session listed in the sidebar",
        45_000,
      );
    },
    "09-session-resume",
  );
  await step("12-pasted-image", () => checkPastedImage(session, mock), "10-stop-running");
} catch (error) {
  matrix.push({ name: "harness", status: "fail", error: String(error) });
} finally {
  try {
    await closeSession();
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
  if (!failed && !values.keep) await removeSandbox(sandbox);
  process.exitCode = failed ? 1 : 0;
}
