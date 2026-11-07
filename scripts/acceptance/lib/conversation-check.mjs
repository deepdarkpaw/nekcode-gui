/** 真实会话验收：只操作页面，使用 mock 请求事实证明回答与停止真正到达 nek。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, screenshot, waitForPage } from "./cdp.mjs";
import {
  clickAt,
  clickOptionAt,
  clickTaskItem,
  fillInput,
  waitForSelector,
  waitForText,
} from "./ui.mjs";
import {
  MOCK_FINAL_TEXT,
  MOCK_FIRST_PROMPT,
  MOCK_IMAGE_FOLLOWUP_PROMPT,
  MOCK_IMAGE_FOLLOWUP_REPLY,
  MOCK_IMAGE_PROMPT,
  MOCK_IMAGE_REPLY,
  MOCK_LONG_PROMPT,
  MOCK_OTHER_ANSWER,
  MOCK_QUESTION_ANSWER_OPTION,
  MOCK_SECOND_QUESTION_TEXT,
} from "./mockLlm.mjs";

const COMPOSER = '[data-testid="v4-composer-input"]';
const SEND = '[data-testid="v4-composer-send"]';
const STOP = '[data-testid="v4-stop"]';
const TRUST = '[data-testid="nek-extension-confirm-card"]';
const SEND_READY = `document.querySelector('${SEND}')?.disabled === false`;
const TRUST_VISIBLE = `Boolean(document.querySelector('${TRUST}'))`;
const UPLOAD_CHIP = "[data-upload-status]";
/** 发送后再观察一段时间：草稿恢复发生在 scope effect 的下一帧之后。 */
const SENT_ATTACHMENT_SETTLE_MS = 1_500;
/** 1×1 PNG：截图粘贴没有本地路径，只能走分片上传。 */
const PASTED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 首发可能先预热会话并询问信任，也可能发送后询问；两种顺序均须真实回答一次。 */
export async function checkFirstPrompt(session, sandbox) {
  let trusted = false;
  const confirmTrust = async () => {
    await waitForText(session, "是否信任此项目", "project trust confirmation");
    await screenshot(session, join(sandbox.screenshots, "06-project-trust.png"));
    await clickAt(session, `${TRUST} [data-interaction-action="nek.interaction.dialog.continue"]`);
    trusted = true;
  };
  await fillInput(session, COMPOSER, MOCK_FIRST_PROMPT);
  await waitForPage(session, `${TRUST_VISIBLE} || ${SEND_READY}`, "trust or enabled send", 60_000);
  if (await evaluate(session, TRUST_VISIBLE)) await confirmTrust();
  await waitForPage(session, SEND_READY, "enabled send after model/trust readiness", 60_000);
  await clickAt(session, SEND);
  await waitForPage(
    session,
    `${TRUST_VISIBLE} || document.body.innerText.includes('I will inspect the workspace')`,
    "trust or assistant response",
    90_000,
  );
  if (!trusted && (await evaluate(session, TRUST_VISIBLE))) await confirmTrust();
  if (!trusted) throw new Error("first session bypassed the required project trust confirmation");
  await waitForText(session, "I will inspect the workspace", "assistant row", 90_000);
  await waitForSelector(session, '[data-testid^="v4-row"]', "timeline rows");
  await waitForText(session, "ls", "ls tool row");
  const trust = JSON.parse(await readFile(join(sandbox.agentDir, "trust.json"), "utf8"));
  const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
  if (
    !Object.entries(trust).some(
      ([path, value]) => normalize(path) === normalize(sandbox.project) && value === true,
    )
  ) {
    throw new Error("trust.json does not contain approval for the sandbox project");
  }
}

export async function checkStatus(session) {
  await waitForPage(
    session,
    `(() => {
    const list = document.querySelector('[data-testid="task-list"]');
    return Boolean(list) && !list.innerText.includes('正在获取任务') && list.querySelectorAll('[data-testid^="task-item"]').length > 0;
  })()`,
    "task list loaded with the conversation",
    60_000,
  );
  await waitForSelector(session, '[data-status-view="session-status-slot"]', "status slot");
  await waitForSelector(session, '[data-status-view="usage-indicator"]', "usage indicator");
  const usage = await evaluate(
    session,
    `document.querySelector('[data-status-view="usage-indicator"]').innerText`,
  );
  if (!/[1-9]/u.test(usage)) throw new Error(`usage indicator has no nonzero usage: ${usage}`);
}

export async function checkInteractions(session, sandbox, mock) {
  const ask = '[data-testid="nek-ask-question-card"]';
  await waitForSelector(session, ask, "ask_question card", 90_000);
  await screenshot(session, join(sandbox.screenshots, "08-question-choice.png"));
  // 单选点击即提交（交互规格 AQ-C1）；不再点击已经卸载的第一张卡的按钮。
  await clickOptionAt(session, MOCK_QUESTION_ANSWER_OPTION);
  await waitForPage(
    session,
    `document.querySelector('${ask}')?.innerText.includes(${JSON.stringify(MOCK_SECOND_QUESTION_TEXT)})`,
    "second question card",
    60_000,
  );
  await fillInput(session, `${ask} [data-interaction-focus="other"]`, MOCK_OTHER_ANSWER);
  await screenshot(session, join(sandbox.screenshots, "08-question-other.png"));
  await clickAt(session, `${ask} [data-interaction-action="nek.interaction.question.submit"]`);
  const mode = '[data-testid="nek-switch-mode-card"]';
  await waitForSelector(session, mode, "switch_mode card", 90_000);
  await screenshot(session, join(sandbox.screenshots, "08-mode-approval.png"));
  await clickAt(session, `${mode} [data-interaction-action="nek.interaction.mode.approvePlan"]`);
  const plan = '[data-testid="nek-plan-review-card"]';
  await waitForSelector(session, plan, "plan review card", 90_000);
  await screenshot(session, join(sandbox.screenshots, "08-plan-review.png"));
  await clickAt(session, `${plan} [data-interaction-action="nek.interaction.plan.implement"]`);
  const deadline = Date.now() + 30_000;
  while (!mock.requests.some((request) => request.turn === "final")) {
    const invalid = mock.requests.find((request) => request.turn === "invalid");
    if (invalid) throw new Error(invalid.error);
    if (Date.now() >= deadline) throw new Error("approved plan did not reach the mock model");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitForText(session, MOCK_FINAL_TEXT, "final assistant reply", 60_000);
  await waitForText(session, "2/2", "plan todos completed", 30_000);
  if (!mock.requests.some((request) => request.turn === "final")) {
    throw new Error("mock did not receive the mode approval result");
  }
}

export async function checkRestoredSession(session) {
  await waitForPage(
    session,
    `[...document.querySelectorAll('[data-testid^="task-item"]')].some((item) =>
      item.innerText.includes(${JSON.stringify(MOCK_FIRST_PROMPT)}))`,
    "restored task item",
    90_000,
  );
  await clickTaskItem(session, MOCK_FIRST_PROMPT);
  await waitForText(session, MOCK_FINAL_TEXT, "restored conversation history", 120_000);
  await waitForSelector(session, '[data-testid^="v4-row"]', "restored timeline rows");
  // 草稿页预热会话会被 nek 落盘；没有消息的会话不能出现在侧栏。
  const taskTitles = await evaluate(
    session,
    `[...document.querySelectorAll('[data-testid^="task-item"]')].map((item) => item.innerText.trim())`,
  );
  if (taskTitles.length !== 1) {
    throw new Error(`sidebar should list only the used session: ${JSON.stringify(taskTitles)}`);
  }
}

/** 粘贴的截图（没有本地路径）分片上传到 host，上传完成后连同文字发出，模型要收到图片。 */
export async function checkPastedImage(session, mock) {
  await evaluate(
    session,
    `(() => {
    const input = document.querySelector('${COMPOSER}');
    if (!(input instanceof HTMLElement)) throw new Error('composer not found');
    input.focus();
    const bytes = Uint8Array.from(atob(${JSON.stringify(PASTED_PNG_BASE64)}), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pasted-image.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  })()`,
  );
  const settled = '[data-upload-status="ready"], [data-upload-status="failed"]';
  await waitForSelector(session, settled, "pasted image upload settled", 60_000);
  const failure = await evaluate(
    session,
    `(() => {
    const failed = document.querySelector('[data-upload-status="failed"]');
    if (!failed) return null;
    return failed.querySelector('[role="alert"]')?.getAttribute('aria-label') || 'upload failed';
  })()`,
  );
  if (failure !== null) throw new Error(`pasted image upload failed: ${failure}`);
  await fillInput(session, COMPOSER, MOCK_IMAGE_PROMPT);
  await waitForPage(session, SEND_READY, "send enabled with the pasted image", 60_000);
  await clickAt(session, SEND);
  await waitForText(session, MOCK_IMAGE_REPLY, "reply to the pasted image", 90_000);
  if (!mock.requests.some((request) => request.turn === "image" && request.hasImage)) {
    throw new Error("the model request did not include the pasted image");
  }
  // 发出的图片必须离开输入框，且不能稍后被草稿恢复回来（否则下一条消息会把它再发一次）。
  await waitForSelector(
    session,
    UPLOAD_CHIP,
    "sent image cleared from the composer",
    30_000,
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, SENT_ATTACHMENT_SETTLE_MS));
  if (await evaluate(session, `document.querySelector('${UPLOAD_CHIP}') !== null`)) {
    throw new Error("the sent image came back into the composer");
  }
  await fillInput(session, COMPOSER, MOCK_IMAGE_FOLLOWUP_PROMPT);
  await waitForPage(session, SEND_READY, "send enabled for the follow-up", 60_000);
  await clickAt(session, SEND);
  await waitForText(session, MOCK_IMAGE_FOLLOWUP_REPLY, "reply to the follow-up", 90_000);
  const followup = mock.requests.findLast((request) => request.turn === "imageFollowup");
  if (!followup) throw new Error("the follow-up message did not reach the model");
  if (followup.hasImage) throw new Error("the follow-up message sent the already-sent image again");
}

export async function checkStop(session, mock) {
  const firstNewRequest = mock.requests.length;
  await fillInput(session, COMPOSER, MOCK_LONG_PROMPT);
  await waitForPage(session, SEND_READY, "enabled send for stop test");
  await clickAt(session, SEND);
  await waitForSelector(session, STOP, "running stop button", 90_000);
  await waitForText(
    session,
    "Working through the long task",
    "streaming output before stop",
    90_000,
  );
  const startedDeadline = Date.now() + 30_000;
  while (!mock.requests.slice(firstNewRequest).some((request) => request.turn === "slow")) {
    if (Date.now() >= startedDeadline) throw new Error("new stop-test stream did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await clickAt(session, STOP);
  await waitForSelector(session, STOP, "stop button cleared", 60_000, false);
  await waitForSelector(session, SEND, "composer send button restored", 60_000);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      mock.requests
        .slice(firstNewRequest)
        .some((request) => request.turn === "slow" && request.aborted)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("stop did not abort the mock stream before harness cleanup");
}
