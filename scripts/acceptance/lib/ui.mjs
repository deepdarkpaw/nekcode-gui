/**
 * 验收用的 renderer DOM 操作与断言助手：全部走页面内真实点击/输入，不注入产品后门。
 * 失败一律抛错，不吞异常。
 */
import { evaluate, waitForPage } from "./cdp.mjs";

const ERROR_BOUNDARY = /应用界面出了点问题|Something went wrong in the app/u;

/** 页面纯文本。 */
export async function pageText(session) {
  return await evaluate(session, "document.body.innerText");
}

/** 断言渲染层没有错误边界、没有未捕获异常。 */
export async function assertNoRendererFailure(session) {
  const text = await pageText(session);
  if (ERROR_BOUNDARY.test(text)) throw new Error("renderer error boundary is visible");
  const exception = session.problems.find((problem) => problem.kind === "exception");
  if (exception) throw new Error(`uncaught renderer exception: ${exception.text}`);
}

/** 元素是否存在。 */
export async function exists(session, selector) {
  return await evaluate(session, `document.querySelector(${JSON.stringify(selector)}) !== null`);
}

/** 点击可见按钮（按可见文本精确或包含匹配）。 */
export async function clickButton(session, text, { contains = false } = {}) {
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

/** 按 data-testid 点击（`exact=false` 时按前缀匹配）。 */
export async function clickTestId(session, testId, { exact = true, index = 0 } = {}) {
  const testIdJson = JSON.stringify(testId);
  await evaluate(
    session,
    `(() => {
      const selector = ${exact ? "`[data-testid=\"${testIdJson}\"]`" : "`[data-testid^=\"${testIdJson}\"]`"};
      const element = document.querySelectorAll(selector)[${index}];
      if (!(element instanceof HTMLElement)) throw new Error("testid target not found: " + ${testIdJson});
      element.click();
    })()`,
  );
}

/** 用真实鼠标事件点击选择器命中的元素（Radix Select 之类只认真实指针事件的控件）。 */
export async function clickAt(session, selector) {
  const rect = await evaluate(
    session,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error("element not found: " + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`,
  );
  const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/** 在卡片里按序号或文本点击按钮；卡片用 data-testid 定位。 */
export async function clickCardButton(session, cardTestId, { text, index } = {}) {
  const card = JSON.stringify(cardTestId);
  const wanted = JSON.stringify(text ?? "");
  await evaluate(
    session,
    `(() => {
      const card = document.querySelector('[data-testid="' + ${card} + '"]');
      if (!(card instanceof HTMLElement)) throw new Error("card not found: " + ${card});
      const buttons = [...card.querySelectorAll("button")].filter((candidate) => !candidate.disabled);
      if (buttons.length === 0) throw new Error("card has no enabled button: " + ${card});
      const target = ${index === undefined ? `buttons.find((candidate) => candidate.innerText.includes(${wanted})) ?? buttons.at(-1)` : `buttons[${index}]`};
      if (!(target instanceof HTMLElement)) throw new Error("card button not found: " + ${wanted});
      target.click();
    })()`,
  );
}

/** 在输入框里输入文本（先聚焦，再走 insertText 以兼容 Lexical）。 */
export async function fillInput(session, selector, text) {
  await evaluate(
    session,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error("input not found: " + ${JSON.stringify(selector)});
      element.focus();
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        element.select?.();
      }
    })()`,
  );
  await session.send("Input.insertText", { text });
}

/** 等待页面出现某段文本。 */
export async function waitForText(session, text, label, timeoutMs = 30_000) {
  await waitForPage(
    session,
    `document.body.innerText.includes(${JSON.stringify(text)})`,
    label ?? text,
    timeoutMs,
  );
}

/** 等待文本消失。 */
export async function waitForTextGone(session, text, label, timeoutMs = 30_000) {
  await waitForPage(
    session,
    `!document.body.innerText.includes(${JSON.stringify(text)})`,
    label ?? `no ${text}`,
    timeoutMs,
  );
}

/** 等待某个选择器出现（或消失）。 */
export async function waitForSelector(session, selector, label, timeoutMs = 30_000, present = true) {
  const expression = present
    ? `document.querySelector(${JSON.stringify(selector)}) !== null`
    : `document.querySelector(${JSON.stringify(selector)}) === null`;
  await waitForPage(session, expression, label ?? selector, timeoutMs);
}
