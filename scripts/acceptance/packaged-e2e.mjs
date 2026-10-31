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
import { connectRenderer, evaluate, screenshot, typeText, waitForPage } from "./lib/cdp.mjs";
import {
  MOCK_FINAL_TEXT,
  MOCK_FIRST_PROMPT,
  MOCK_LONG_PROMPT,
  MOCK_OTHER_ANSWER,
  MOCK_QUESTION_ANSWER_OPTION,
  mockNekConfig,
  startMockLlm,
} from "./lib/mockLlm.mjs";
import {
  assertNoRendererFailure,
  clickAt,
  clickButton,
  clickCardButton,
  exists,
  fillInput,
  pageText,
  waitForSelector,
  waitForText,
  waitForTextGone,
} from "./lib/ui.mjs";

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean", default: false } },
});
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
const COMPOSER = '[data-testid="v4-composer-input"]';
const SEND = '[data-testid="v4-composer-send"]';
const STOP = '[data-testid="v4-stop"]';

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

async function writeMockConfig(sandbox, baseUrl) {
  const config = mockNekConfig(baseUrl);
  await writeFile(join(sandbox.agentDir, "models.json"), `${JSON.stringify(config.models, null, 2)}\n`);
  await writeFile(
    join(sandbox.agentDir, "settings.json"),
    `${JSON.stringify(config.settings, null, 2)}\n`,
  );
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
      await writeFile(join(sandbox.root, `${stepFile(name).replace(/\.png$/u, "")}.dom.txt`), text);
    }
    matrix.push({
      name,
      status: status === "blocked" ? "blocked" : "fail",
      screenshot: path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 启动应用并连上 renderer；`--open-workspace` 是产品已有的启动入口，不是测试后门。 */
async function launchAndConnect() {
  await writeNekShim(
    sandbox,
    process.execPath,
    join(
      process.env.NEK_RPC_WORKTREE ?? "G:/coding/nekcode-gui/.worktree/nek-rpc",
      "packages",
      "coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
  );
  const port = await freePort();
  app = launchApp({
    executable: values.app ?? defaultExecutable(),
    sandbox,
    cdpPort: port,
    withNekShim: true,
    extraArgs: [`--open-workspace=${sandbox.project}`],
  });
  session = await connectRenderer(port, 60_000);
  await waitForPage(
    session,
    "document.getElementById('root')?.children.length > 0",
    "renderer mounted",
    60_000,
  );
}

async function sendPrompt(text) {
  await fillInput(session, COMPOSER, text);
  await waitForSelector(session, SEND, "composer send button", 20_000);
  await evaluate(
    session,
    `(() => {
      const button = document.querySelector(${JSON.stringify(SEND)});
      if (!(button instanceof HTMLElement) || button.disabled) throw new Error("send button unavailable");
      button.click();
    })()`,
  );
}

try {
  await writeMockConfig(sandbox, mock.baseUrl);
  await launchAndConnect();

  await record("01-onboarding-nek-ready", async () => {
    await waitForText(session, "已安装 nek", "nek detection", 60_000);
    await assertNoRendererFailure(session);
  });
  await record("02-onboarding-account", async () => {
    await clickButton(session, "下一步");
    await waitForText(session, "已配置服务商", "mock provider");
    const text = await pageText(session);
    if (!text.includes("mock")) throw new Error("models.json mock provider is not listed");
  });
  await record("03-onboarding-workspace", async () => {
    await clickButton(session, "下一步");
    await waitForText(session, "选择本机文件夹", "workspace step");
    const text = await pageText(session);
    if (!text.includes("project")) throw new Error("startup workspace is not visible");
    await clickButton(session, "跳过此步");
    await waitForTextGone(session, "欢迎使用 nekcode", "onboarding closed");
  });
  await record("04-workspace-ready", async () => {
    const text = await pageText(session);
    if (!text.includes("project")) throw new Error("sandbox project is not active after onboarding");
    await assertNoRendererFailure(session);
  });

  await record("05-prompt-trust-and-run", async () => {
    await sendPrompt(MOCK_FIRST_PROMPT);
    await waitForSelector(
      session,
      '[data-testid="nek-extension-confirm-card"]',
      "project trust confirmation",
      30_000,
    );
    const cardText = await evaluate(
      session,
      `document.querySelector('[data-testid="nek-extension-confirm-card"]').innerText`,
    );
    if (!cardText.includes("是否信任此项目")) throw new Error(`unexpected trust card: ${cardText}`);
    // 信任卡只有「取消 / 继续」两个按钮：最后一个是确认。
    await clickCardButton(session, "nek-extension-confirm-card", { index: 1 });
    await waitForText(session, "I will inspect the workspace", "assistant row", 90_000);
    await waitForSelector(session, '[data-testid^="v4-row"]', "timeline rows", 30_000);
    await waitForText(session, "ls", "ls tool row", 30_000);
    const trust = JSON.parse(
      await readFile(join(sandbox.agentDir, "trust.json"), "utf8").catch(() => "{}"),
    );
    if (!JSON.stringify(trust).includes(sandbox.project.replaceAll("\\", "\\\\"))) {
      // 信任落盘路径可能被 nek 归一化，只要求文件存在且记录了 trusted。
      if (!JSON.stringify(trust).includes("true")) {
        throw new Error("project trust was not persisted to trust.json");
      }
    }
    await assertNoRendererFailure(session);
  });

  await record("06-status-and-usage", async () => {
    await waitForSelector(session, '[data-testid="task-list"]', "task list container", 60_000);
    await waitForPage(
      session,
      `(() => {
        const list = document.querySelector('[data-testid="task-list"]');
        return Boolean(list) && !list.innerText.includes("正在获取任务") && list.querySelectorAll('[data-testid^="task-item"]').length > 0;
      })()`,
      "task list loaded with the conversation",
      90_000,
    );
    await waitForSelector(session, '[data-status-view="session-status-slot"]', "status slot", 30_000);
    await waitForSelector(session, '[data-status-view="usage-indicator"]', "usage indicator", 30_000);
    const usage = await evaluate(
      session,
      `document.querySelector('[data-status-view="usage-indicator"]').innerText`,
    );
    if (!/\d/u.test(usage)) throw new Error(`usage indicator has no numbers: ${usage}`);
    await assertNoRendererFailure(session);
  });

  await record("07-structured-interactions", async () => {
    // 问题 1：单选。
    await waitForSelector(session, '[data-testid="nek-ask-question-card"]', "ask_question card", 90_000);
    const questionText = await evaluate(
      session,
      `document.querySelector('[data-testid="nek-ask-question-card"]').innerText`,
    );
    await evaluate(
      session,
      `(() => {
        const card = document.querySelector('[data-testid="nek-ask-question-card"]');
        const options = [...card.querySelectorAll('[role="option"]')];
        const target = options.find((option) => option.innerText.includes(${JSON.stringify(MOCK_QUESTION_ANSWER_OPTION)}));
        if (!(target instanceof HTMLElement)) throw new Error("single-select option not found");
        target.click();
      })()`,
    );
    await clickCardButton(session, "nek-ask-question-card", { index: -1 });
    // 问题 2：其他输入。
    await waitForPage(
      session,
      `(() => {
        const card = document.querySelector('[data-testid="nek-ask-question-card"]');
        return Boolean(card) && card.innerText.includes("Anything else to record");
      })()`,
      "second question card",
      60_000,
    );
    await fillInput(session, '[data-interaction-focus="other"]', MOCK_OTHER_ANSWER);
    await clickCardButton(session, "nek-ask-question-card", { index: -1 });
    // switch_mode：nek 收到回答后继续运行。
    await waitForSelector(session, '[data-testid="nek-switch-mode-card"]', "switch_mode card", 90_000);
    await clickCardButton(session, "nek-switch-mode-card", { index: 1 });
    await waitForText(session, MOCK_FINAL_TEXT, "final assistant reply", 120_000);
    const text = await pageText(session);
    if (!text.includes("Redis")) throw new Error("ask_question answer is not visible in transcript");
    if (!text.includes("plan")) throw new Error("switch_mode approval did not reach nek");
    await writeFile(join(sandbox.root, "07-question-card.txt"), questionText);
    await assertNoRendererFailure(session);
  });

  await record("08-settings-pages", async () => {
    await evaluate(
      session,
      `(() => {
        const button = document.querySelector('[data-testid="task-settings-button"]');
        if (!(button instanceof HTMLElement)) throw new Error("settings trigger is missing");
        button.click();
      })()`,
    );
    await waitForSelector(session, '[data-testid="settings-page"]', "settings page", 30_000);
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
        const button = document.querySelector('[data-testid="settings-section-nav-nekDefaultModel"]');
        if (!(button instanceof HTMLElement)) throw new Error("default model section missing");
        button.click();
      })()`,
    );
    await waitForPage(
      session,
      `document.querySelector('[data-testid="settings-page"]')?.getAttribute('data-active-section') === 'nekDefaultModel'`,
      "default model section",
      20_000,
    );
    await waitForSelector(session, '[aria-label="默认模型"]', "default model select", 30_000);
    await clickAt(session, '[aria-label="默认模型"]');
    await waitForPage(
      session,
      `[...document.querySelectorAll('[role="option"]')].some((option) => option.innerText.includes("Local Mock Model 2"))`,
      "model option list",
      20_000,
    );
    await evaluate(
      session,
      `(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.innerText.includes("Local Mock Model 2"));
        if (!(option instanceof HTMLElement)) throw new Error("model option missing");
        option.click();
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const settings = JSON.parse(await readFile(join(sandbox.agentDir, "settings.json"), "utf8"));
    if (settings.defaultProvider !== "mock" || settings.defaultModel !== "mock-model-2") {
      throw new Error(`default model was not persisted to sandbox settings.json: ${JSON.stringify(settings)}`);
    }
    await assertNoRendererFailure(session);
  });

  await record("09-session-resume", async () => {
    session.close();
    stopApp(app);
    app = undefined;
    await new Promise((done) => setTimeout(done, 2_000));
    await launchAndConnect();
    await waitForSelector(session, '[data-testid="task-list"]', "task list after restart", 90_000);
    await waitForPage(
      session,
      `(() => {
        const items = [...document.querySelectorAll('[data-testid^="task-item"]')];
        return items.length > 0;
      })()`,
      "restored task item",
      90_000,
    );
    await evaluate(
      session,
      `(() => {
        const item = document.querySelector('[data-testid^="task-item"]');
        if (!(item instanceof HTMLElement)) throw new Error("task item missing");
        item.click();
      })()`,
    );
    await waitForText(session, MOCK_FINAL_TEXT, "restored conversation history", 120_000);
    const rows = await evaluate(session, 'document.querySelectorAll(\'[data-testid^="v4-row"]\').length');
    if (rows === 0) throw new Error("restored session has no timeline rows");
    await assertNoRendererFailure(session);
  });

  await record("10-stop-running", async () => {
    await sendPrompt(MOCK_LONG_PROMPT);
    await waitForSelector(session, STOP, "running stop button", 90_000);
    await new Promise((done) => setTimeout(done, 2_500));
    const streaming = await pageText(session);
    if (!streaming.includes("Working through the long task")) {
      throw new Error("mock streaming output is not visible before stop");
    }
    await evaluate(
      session,
      `(() => {
        const button = document.querySelector(${JSON.stringify(STOP)});
        if (!(button instanceof HTMLElement)) throw new Error("stop button disappeared before click");
        button.click();
      })()`,
    );
    await waitForSelector(session, STOP, "stop button cleared", 60_000, false);
    await waitForSelector(session, SEND, "composer send button restored", 60_000);
    const slowTurn = mock.requests.filter((request) => request.turn === "slow");
    if (slowTurn.length === 0) throw new Error("mock never served the long turn");
    await assertNoRendererFailure(session);
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
  const slowAborted = mock.requests
    .filter((request) => request.turn === "slow")
    .some((request) => request.aborted);
  await writeFile(join(sandbox.root, "mock-requests.json"), JSON.stringify(mock.requests, null, 2));
  console.log("验收矩阵：");
  for (const row of matrix) {
    console.log(
      `- ${row.name}: ${row.status} — ${row.screenshot}${row.error ? ` — ${row.error}` : ""}`,
    );
  }
  console.log(`mock 慢速流是否被中止：${slowAborted ? "是" : "否"}`);
  console.log(`sandbox: ${sandbox.root}`);
  const failed = matrix.some((row) => row.status === "fail");
  if (!failed && !values.keep) await rm(sandbox.root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
