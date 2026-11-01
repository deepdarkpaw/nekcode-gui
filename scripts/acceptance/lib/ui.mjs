/** CDP 页面操作：目标必须可见、可用且未被遮挡；找不到目标就失败，不改点其他按钮。 */
import { evaluate, waitForPage } from "./cdp.mjs";

const ERROR_BOUNDARY = /应用界面出了点问题|Something went wrong in the app/u;

export async function pageText(session) {
  return await evaluate(session, "document.body.innerText");
}

export async function assertNoRendererFailure(session) {
  if (ERROR_BOUNDARY.test(await pageText(session)))
    throw new Error("renderer error boundary is visible");
  const failure = session.problems.find(
    (problem) => problem.kind === "exception" || /MaxListenersExceededWarning/u.test(problem.text),
  );
  if (failure) throw new Error(`renderer failure: ${failure.text}`);
}

/** 所有点击共用一个几何/禁用/遮挡检查，确保 Chromium 收到真实鼠标事件。 */
async function clickTarget(session, expression) {
  const rect = await evaluate(
    session,
    `(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) throw new Error('click target not found');
    if (element.matches(':disabled, [aria-disabled="true"]')) throw new Error('click target is disabled');
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) throw new Error('click target is not visible');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('click target is covered');
    return { x, y };
  })()`,
  );
  const base = { ...rect, button: "left", clickCount: 1 };
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect });
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

export async function clickAt(session, selector) {
  await clickTarget(session, `document.querySelector(${JSON.stringify(selector)})`);
}

export async function clickButton(session, text) {
  await clickTarget(
    session,
    `[...document.querySelectorAll('button')].find((button) =>
    !button.disabled && button.getClientRects().length > 0 && button.innerText.trim() === ${JSON.stringify(text)})`,
  );
}

/** 按标题点开侧栏会话；同一工作区可能同时存在草稿会话，不能按顺序点。 */
export async function clickTaskItem(session, text) {
  await clickTarget(
    session,
    `[...document.querySelectorAll('[data-testid^="task-item"]')].find((item) =>
    item.getClientRects().length > 0 && item.innerText.includes(${JSON.stringify(text)}))`,
  );
}

export async function clickOptionAt(session, text) {
  await clickTarget(
    session,
    `[...document.querySelectorAll('[role="option"]')].find((option) =>
    option.getClientRects().length > 0 && option.innerText.includes(${JSON.stringify(text)}))`,
  );
}

/** 替换完整输入；contenteditable 使用 DOM selection，不拼接上一条草稿。 */
export async function fillInput(session, selector, text) {
  await evaluate(
    session,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('input not found');
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      element.select();
    } else if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else throw new Error('target is not editable');
  })()`,
  );
  await session.send("Input.insertText", { text });
}

export async function waitForText(session, text, label = text, timeoutMs = 30_000) {
  await waitForPage(
    session,
    `document.body.innerText.includes(${JSON.stringify(text)})`,
    label,
    timeoutMs,
  );
}

export async function waitForTextGone(session, text, label = `no ${text}`, timeoutMs = 30_000) {
  await waitForPage(
    session,
    `!document.body.innerText.includes(${JSON.stringify(text)})`,
    label,
    timeoutMs,
  );
}

export async function waitForSelector(
  session,
  selector,
  label = selector,
  timeoutMs = 30_000,
  present = true,
) {
  await waitForPage(
    session,
    `document.querySelector(${JSON.stringify(selector)}) ${present ? "!==" : "==="} null`,
    label,
    timeoutMs,
  );
}
