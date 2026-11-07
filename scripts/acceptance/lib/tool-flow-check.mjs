/** Post-submit and restored-history assertions against the real producer and packaged renderer. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, screenshot, waitForPage } from "./cdp.mjs";
import { clickAt, fillInput, waitForText, waitForSelector } from "./ui.mjs";
import {
  MOCK_FILE_NAME,
  MOCK_FILE_CONTENT,
  MOCK_FILE_PROMPT,
  MOCK_FILE_REPLY,
  MOCK_LONG_PROMPT,
  MOCK_QUEUE_PROMPT,
  MOCK_QUEUE_REPLY,
  MOCK_OTHER_ANSWER,
  MOCK_QUESTION_ANSWER_OPTION,
} from "./mockLlm.mjs";

const COMPOSER = '[data-testid="v4-composer-input"]';
const SEND = '[data-testid="v4-composer-send"]';
const GROUP = '[data-changes-group="true"]';

async function send(session, text) {
  await fillInput(session, COMPOSER, text);
  await waitForPage(
    session,
    `document.querySelector('${SEND}')?.disabled === false`,
    "send enabled",
  );
  await clickAt(session, SEND);
}

async function openHistory(session) {
  const selector = '[data-testid^="chat-assistant-history-trigger"][data-history-open="false"]';
  for (let count = 0; count < 12; count++) {
    if (!(await evaluate(session, `Boolean(document.querySelector('${selector}'))`))) return;
    await clickAt(session, selector);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("unexpected number of collapsed history sections");
}

export async function checkAcceptedAnswers(session) {
  // A real wheel event releases live-tail following; programmatic scrollIntoView alone does not.
  const point = await evaluate(
    session,
    `(() => {
    const box = document.querySelector('[data-testid="v4-timeline"]').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`,
  );
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -10000,
  });
  await waitForPage(
    session,
    `document.querySelector('[data-testid="v4-timeline"]').scrollTop < 4`,
    "history scrolled to top",
  );
  await openHistory(session);
  const card = '[data-tool-name="ask_question"]';
  await waitForSelector(session, `${card} [aria-expanded]`, "answered historical question toggle");
  const toggle = `${card} [aria-expanded="false"]`;
  if (await evaluate(session, `Boolean(document.querySelector('${toggle}'))`))
    await clickAt(session, toggle);
  await waitForPage(
    session,
    `(() => {
    const text = document.querySelector('${card}')?.innerText ?? '';
    return text.includes(${JSON.stringify(MOCK_OTHER_ANSWER)}) && text.includes(${JSON.stringify(MOCK_QUESTION_ANSWER_OPTION)}) && !/未提供回答|答案不可用/.test(text);
  })()`,
    "accepted labels and Other text in historical card",
  );
}

export async function checkFileSummary(session) {
  await openHistory(session);
  await waitForSelector(session, GROUP);
  await waitForPage(
    session,
    `(() => {
    const group = document.querySelector('${GROUP}');
    return group?.innerText.includes('累计 3 次成功操作') && group.querySelector('[aria-label="+2"]') && group.querySelector('[aria-label="-2"]') && group.innerText.includes('部分操作无增删统计');
  })()`,
    "three successful operations: two known edits +2/-2; write has no preimage",
  );
  const toggle = `${GROUP} [aria-expanded="false"]`;
  if (!(await evaluate(session, `Boolean(document.querySelector('[data-change-file]'))`)))
    await clickAt(session, toggle);
  await waitForPage(
    session,
    `document.querySelectorAll('[data-change-file]').length === 1`,
    "one item for the full file path",
  );
  if (await evaluate(session, "document.body.innerText.includes('工作区 Git 差异')"))
    throw new Error("obsolete Git summary is visible");
}

export async function checkFileFlow(session, sandbox, mock) {
  await send(session, MOCK_FILE_PROMPT);
  await waitForSelector(session, GROUP, "streaming changes group");
  await clickAt(session, `${GROUP} [aria-expanded="false"]`);
  const path = `${sandbox.project.replaceAll("\\", "/")}/${MOCK_FILE_NAME}`;
  await waitForPage(
    session,
    `document.querySelector('[data-change-file]')?.getAttribute('data-change-file') === ${JSON.stringify(path)}`,
    "complete path before tool execution",
  );
  await waitForText(session, MOCK_FILE_NAME, "streaming filename rendered before execution");
  await waitForPage(
    session,
    `document.querySelector('${GROUP}').getAnimations({ subtree: true }).every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)`,
    "streaming group expanded",
  );
  await screenshot(session, join(sandbox.screenshots, "streaming-full-path.png"));
  mock.releaseFileStream();
  await waitForText(session, MOCK_FILE_REPLY, "file operations finished", 60_000);
  await checkFileSummary(session);
  const actual = await readFile(join(sandbox.project, MOCK_FILE_NAME), "utf8");
  if (actual !== MOCK_FILE_CONTENT.replace("alpha", "omega"))
    throw new Error("file content/escaping mismatch");
  await writeFile(
    join(sandbox.root, "tool-dom-metrics.json"),
    JSON.stringify(
      await evaluate(
        session,
        `({
    mountedNodes: document.querySelectorAll('*').length,
    fileItems: document.querySelectorAll('[data-change-file]').length,
    expandedOperationRows: document.querySelectorAll('[data-change-file] [data-tool-name]').length
  })`,
      ),
      null,
      2,
    ),
  );
}

export async function checkQueuedMessage(session) {
  await send(session, MOCK_LONG_PROMPT);
  await waitForText(session, "Working through the long task");
  await send(session, MOCK_QUEUE_PROMPT);
  await waitForText(session, "已排队，等待当前步骤结束", "authoritative pending queue");
  await waitForText(session, MOCK_QUEUE_REPLY, "queued prompt reached producer", 60_000);
  await waitForPage(
    session,
    `!document.body.innerText.includes('已排队，等待当前步骤结束')`,
    "pending item removed after consumption",
  );
}
