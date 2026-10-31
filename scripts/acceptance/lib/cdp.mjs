/**
 * 最小 CDP 客户端：连接 Electron renderer 页面，执行脚本、截图、注入输入，并收集运行期错误。
 * 只用于验收脚本；错误一律抛出，不吞。
 */
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

/** 运行期错误上限：只保留前若干条，避免异常风暴撑爆内存。 */
const MAX_PROBLEMS = 200;

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询 `/json` 直到出现页面目标。 */
async function findPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"));
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`no renderer page on CDP port ${port} within ${timeoutMs} ms`, {
    cause: lastError,
  });
}

function describeProblem(message) {
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    return { kind: "exception", text: details.exception?.description ?? details.text };
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    return { kind: "console.error", text };
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "warning") {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    return { kind: "console.warn", text };
  }
  return null;
}

/** 连接页面并启用 Runtime/Page；返回会话对象。 */
export async function connectRenderer(port, timeoutMs = 60_000) {
  const page = await findPageTarget(port, timeoutMs);
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const pending = new Map();
  const problems = [];
  let nextId = 0;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    const problem = describeProblem(message);
    if (problem && problems.length < MAX_PROBLEMS) problems.push(problem);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  return { page, send, problems, close: () => socket.close() };
}

/** 在页面里求值并返回结果；页面内抛错会变成这里的异常。 */
export async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`page evaluation failed: ${text}`);
  }
  return result.result?.value;
}

/** 轮询页面表达式直到为真；超时把最后的页面文本带进错误信息。 */
export async function waitForPage(session, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(session, `Boolean(${expression})`)) return;
    await delay(300);
  }
  const text = await evaluate(session, "document.body.innerText.slice(0, 1200)");
  throw new Error(`timed out waiting for ${label} (${timeoutMs} ms). Page text:\n${text}`);
}

/** 截取当前页面（与窗口在屏幕上的位置无关）。 */
export async function screenshot(session, path) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path, Buffer.from(data, "base64"));
}

/** 键入文本（走 IME 无关的 insertText，Lexical 能正常接收）。 */
export async function typeText(session, text) {
  await session.send("Input.insertText", { text });
}

/** 发送一个按键（keyDown + keyUp）。 */
export async function pressKey(session, key, code = key, keyCode = 0) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
