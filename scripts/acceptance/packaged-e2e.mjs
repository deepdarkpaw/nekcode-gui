/**
 * 打包应用真实链路验收：隔离 HOME + nek shim + 本地 SSE mock，所有断言走 CDP DOM。
 * 不会读取或写入真实 ~/.nek，也不会访问真实模型服务。
 * 用法：node scripts/acceptance/packaged-e2e.mjs [--app <path>] [--keep]
 */
import { readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createSandbox,
  freePort,
  launchApp,
  stopApp,
  writeNekShim,
} from "./lib/app.mjs";
import {
  connectRenderer,
  evaluate,
  screenshot,
  typeText,
  waitForPage,
} from "./lib/cdp.mjs";
import { mockNekConfig, startMockLlm } from "./lib/mockLlm.mjs";

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean", default: false } },
});
const ERROR_BOUNDARY = /应用界面出了点问题|Something went wrong in the app/u;
const NEK_SETTINGS = [
  "nekAccounts",
  "nekProviders",
  "nekDefaultModel",
  "nekCompaction",
  "nekTools",
  "nekMcp",
  "nekAgent",
  "nekProject",
  "nekRemoteHosts",
  "nekAppearance",
  "nekShortcuts",
  "nekAdvanced",
  "nekAbout",
];

function defaultExecutable() {
  const root = resolve("packages/desktop/dist");
  if (process.platform === "win32") {
    const dir = join(root, "win-unpacked");
    const name = readdirSync(dir).find((entry) => /^nekcode.*\.exe$/iu.test(entry));
    if (!name) throw new Error(`no Windows executable in ${dir}`);
    return join(dir, name);
  }
  if (process.platform === "linux") {
    const dir = join(root, "linux-unpacked");
    const name = readdirSync(dir).find((entry) => /^nekcode/iu.test(entry));
    if (!name) throw new Error(`no Linux executable in ${dir}`);
    return join(dir, name);
  }
  throw new Error("macOS acceptance requires --app pointing at the packaged executable");
}

function stepFile(name) {
  return `${name.replace(/[^a-z0-9_-]+/giu, "-")}.png`;
}

async function clickButton(session, text, { contains = false } = {}) {
  const wanted = JSON.stringify(text);
  await evaluate(
    session,
    `(() => {
      const wanted = ${wanted};
      const button = [...document.querySelectorAll("button")].find((candidate) => {
        const label = candidate.innerText.trim();
        return !candidate.disabled && ${contains ? "label.includes(wanted)" : "label === wanted"};
      });
      if (!button) throw new Error("enabled button not found: " + wanted);
      button.click();
    })()`,
  );
}

async function pageText(session) {
  return await evaluate(session, "document.body.innerText");
}

async function assertNoRendererFailure(session) {
  const text = await pageText(session);
  if (ERROR_BOUNDARY.test(text)) throw new Error("renderer error boundary is visible");
  const exception = session.problems.find((problem) => problem.kind === "exception");
  if (exception) throw new Error(`uncaught renderer exception: ${exception.text}`);
}

async function writeMockConfig(sandbox, baseUrl) {
  const config = mockNekConfig(baseUrl);
  await writeFile(join(sandbox.agentDir, "models.json"), `${JSON.stringify(config.models, null, 2)}\n`);
  await writeFile(join(sandbox.agentDir, "settings.json"), `${JSON.stringify(config.settings, null, 2)}\n`);
}

const sandbox = await createSandbox("e2e");
await mkdir(sandbox.screenshots, { recursive: true });
const mock = await startMockLlm();
const matrix = [];
let session;
let app;

async function record(name, action, status = "pass") {
  const path = join(sandbox.screenshots, stepFile(name));
  try {
    if (action) await action();
    if (session) await screenshot(session, path);
    matrix.push({ name, status, screenshot: path });
  } catch (error) {
    if (session) {
      await screenshot(session, path).catch(() => undefined);
      const text = await pageText(session).catch(() => "<DOM unavailable>");
      await writeFile(
        join(sandbox.root, `${stepFile(name).replace(/\.png$/u, "")}.dom.txt`),
        text,
      );
    }
    matrix.push({
      name,
      status: status === "blocked" ? "blocked" : "fail",
      screenshot: path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function start() {
  await writeMockConfig(sandbox, mock.baseUrl);
  const nekRoot = process.env.NEK_RPC_WORKTREE ?? "G:/coding/nekcode-gui/.worktree/nek-rpc";
  await writeNekShim(
    sandbox,
    process.execPath,
    join(nekRoot, "packages", "coding-agent", "dist", "bundle", "cli.js"),
  );
  const port = await freePort();
  app = launchApp({
    executable: values.app ?? defaultExecutable(),
    sandbox,
    cdpPort: port,
    withNekShim: true,
    // 原生目录选择器无法由 CDP 操作；这是产品已有的正规启动入口，不是测试后门。
    extraArgs: [`--open-workspace=${sandbox.project}`],
  });
  session = await connectRenderer(port, 60_000);
  await waitForPage(
    session,
    "document.getElementById('root')?.children.length > 0",
    "renderer mounted",
    60_000,
  );
  await waitForPage(session, "document.body.innerText.includes('已安装 nek')", "nek detection", 60_000);
}

try {
  await start();
  await record("01-onboarding-nek-ready", async () => {
    await waitForPage(session, "document.body.innerText.includes('已安装 nek')", "nek ready");
    await assertNoRendererFailure(session);
  });
  await record("02-onboarding-account", async () => {
    await clickButton(session, "下一步");
    await waitForPage(session, "document.body.innerText.includes('已配置服务商')", "mock provider");
    const text = await pageText(session);
    if (!text.includes("mock")) throw new Error("models.json mock provider is not listed");
  });
  await record("03-onboarding-workspace", async () => {
    await clickButton(session, "下一步");
    await waitForPage(session, "document.body.innerText.includes('选择本机文件夹')", "workspace step");
    const text = await pageText(session);
    if (!text.includes("project")) throw new Error("startup workspace is not visible");
    await clickButton(session, "跳过此步");
    await waitForPage(session, "!document.body.innerText.includes('欢迎使用 nekcode')", "onboarding closed");
  });
  await record("04-workspace-ready", async () => {
    const text = await pageText(session);
    if (!text.includes("project")) throw new Error("sandbox project is not active after onboarding");
  });

  await record("05-prompt-trust-and-run", async () => {
    await evaluate(session, "document.querySelector('[data-testid=\"v4-composer-input\"]')?.focus()");
    await typeText(session, "List the files in this workspace.");
    await clickButton(session, "发送");
    await waitForPage(
      session,
      "document.body.innerText.includes('信任') || document.body.innerText.includes('项目设置')",
      "project trust confirmation",
      20_000,
    );
    await clickButton(session, "信任", { contains: true });
    await waitForPage(session, "document.body.innerText.includes('I will inspect')", "assistant row", 60_000);
    await waitForPage(session, "document.body.innerText.includes('ls')", "ls tool row", 60_000);
    await waitForPage(session, "document.body.innerText.includes('The workspace listing is complete.')", "final reply", 60_000);
  }, "blocked");
  await record("06-status-and-usage", async () => {
    const text = await pageText(session);
    const usage = await evaluate(
      session,
      "Boolean(document.querySelector('[data-testid*=\"usage\" i], [aria-label*=\"用量\" i]'))",
    );
    if (!usage && !/tokens|用量|usage/iu.test(text)) throw new Error("usage indicator has no data");
  }, "blocked");

  matrix.push({
    name: "07-structured-interactions",
    status: "blocked",
    screenshot: join(sandbox.screenshots, stepFile("07-structured-interactions")),
    error:
      "阻塞于 Sol B 范围：当前分支尚未包含 renderer interaction feed；不能伪造 ask_question/plan_review/switch_mode 回答。",
  });
  await screenshot(session, join(sandbox.screenshots, stepFile("07-structured-interactions")));

  await record("08-settings-pages", async () => {
    await evaluate(
      session,
      `(() => {
        const button = document.querySelector('[data-testid="task-settings-button"]');
        if (!(button instanceof HTMLElement)) throw new Error("settings trigger is missing");
        button.click();
      })()`,
    );
    await waitForPage(session, "document.querySelector('[data-testid=\"settings-page\"]')", "settings page");
    for (const section of NEK_SETTINGS) {
      await evaluate(
        session,
        `(() => {
          const button = document.querySelector('[data-testid="settings-section-nav-${section}"]');
          if (!(button instanceof HTMLElement)) throw new Error("settings section missing: ${section}");
          button.click();
        })()`,
      );
      await waitForPage(
        session,
        `document.querySelector('[data-testid="settings-page"]')?.getAttribute('data-active-section') === '${section}'`,
        section,
        20_000,
      );
      await assertNoRendererFailure(session);
    }
    await evaluate(
      session,
      `(() => {
        const select = document.querySelector('[aria-label="默认模型"]');
        if (!(select instanceof HTMLElement)) throw new Error("default model control missing");
        select.click();
      })()`,
    );
    await waitForPage(session, "document.body.innerText.includes('Local Mock Model')", "default model option");
    await clickButton(session, "Local Mock Model");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const settings = JSON.parse(await readFile(join(sandbox.agentDir, "settings.json"), "utf8"));
    if (settings.defaultProvider !== "mock" || settings.defaultModel !== "mock-model") {
      throw new Error("default model was not persisted to sandbox settings.json");
    }
  });

  matrix.push({
    name: "09-session-resume",
    status: "blocked",
    screenshot: join(sandbox.screenshots, stepFile("09-session-resume")),
    error: "依赖 05 的 nek 会话完成；若 05 受 Sol B interaction feed 阻塞，本项不可冒充通过。",
  });
  matrix.push({
    name: "10-stop-running",
    status: "blocked",
    screenshot: join(sandbox.screenshots, stepFile("10-stop-running")),
    error: "依赖真实运行态；当前分支的 renderer feed 阻塞，未伪造停止结果。",
  });
} catch (error) {
  matrix.push({
    name: "harness",
    status: "fail",
    screenshot: join(sandbox.screenshots, stepFile("harness")),
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (session) session.close();
  if (app) stopApp(app);
  await mock.close();
  console.log("验收矩阵：");
  for (const row of matrix) {
    console.log(`- ${row.name}: ${row.status} — ${row.screenshot}${row.error ? ` — ${row.error}` : ""}`);
  }
  console.log(`sandbox: ${sandbox.root}`);
  const failed = matrix.some((row) => row.status === "fail");
  if (!failed && !values.keep) await rm(sandbox.root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
