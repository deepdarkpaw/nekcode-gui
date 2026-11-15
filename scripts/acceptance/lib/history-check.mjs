/**
 * 长历史验收：在沙箱 agentDir 写入 70 轮、累计超过 64 MB 的会话（每轮一次读图工具结果约 1.1 MB），
 * 从侧栏打开，证明首帧不触发 JSONL 单条上限、最新 20 轮完整可见（超过 4 KB 的回答不再被替换成
 * 按需原文块）、滚到顶部点按钮按整轮向前取页、不出现轮内补载入口，且子代理引用不被拦截。
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate, waitForPage } from "./cdp.mjs";
import { clickButton, clickTaskItem, waitForText } from "./ui.mjs";

const LONG_HISTORY_TURNS = 70;
const LONG_HISTORY_TITLE = "long history prompt 1";
const JSONL_RECORD_LIMIT = 64 * 1024 * 1024;
const SUBAGENT_ID = "0f8e4a52-6b1d-4c3e-9a7f-2d5b8c1e4f60";
const TIMELINE = '[data-testid="v4-timeline"]';
/** 每轮一张约 1.1 MB 的工具结果图片（GUI 不展示其字节），使 70 轮累计超过 64 MB。 */
const IMAGE_BASE64 = "A".repeat(1_100_000);
/** 约 6 KB 的回答：旧实现会把超过 4 KB 的正文换成“按需查看内容”块。 */
const LONG_ANSWER = "长回答正文。".repeat(1_000);

/** 与 nek getDefaultSessionDirPath 相同的 cwd 编码。 */
function sessionDir(agentDir, cwd) {
  const safe = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safe);
}

/** 流式写入，不在内存中拼出整份会话。返回会话文件路径与字节数。 */
export function writeLongHistorySession(sandbox) {
  const dir = sessionDir(sandbox.agentDir, sandbox.project);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const timestamp = "2026-11-01T00:00:00.000Z";
  const path = join(dir, `2026-11-01T00-00-00-000Z_${id}.jsonl`);
  const fd = openSync(path, "w");
  const line = (value) => writeSync(fd, `${JSON.stringify(value)}\n`);
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const assistant = (n, slot, content, stopReason) => ({
    role: "assistant",
    api: "openai-completions",
    provider: "mock",
    model: "offline",
    timestamp: n * 1000 + slot,
    content,
    stopReason,
    usage: { ...usage, cost },
  });
  try {
    line({ type: "session", version: 3, id, timestamp, cwd: resolve(sandbox.project) });
    for (let n = 1; n <= LONG_HISTORY_TURNS; n += 1) {
      const last = n === LONG_HISTORY_TURNS;
      const text = last
        ? `long history answer ${n}, see [Researcher](${SUBAGENT_ID}) ${LONG_ANSWER} END-OF-ANSWER-${n}`
        : `long history answer ${n} ${LONG_ANSWER} END-OF-ANSWER-${n}`;
      const call = `call-${n}`;
      line({
        id: `u${n}`,
        parentId: n === 1 ? null : `f${n - 1}`,
        type: "message",
        timestamp,
        message: { role: "user", content: `long history prompt ${n}`, timestamp: n * 1000 },
      });
      line({
        id: `a${n}`,
        parentId: `u${n}`,
        type: "message",
        timestamp,
        message: assistant(
          n,
          1,
          [
            { type: "text", text: `reading screenshot ${n}` },
            { type: "toolCall", id: call, name: "read", arguments: { path: `shot-${n}.png` } },
          ],
          "toolUse",
        ),
      });
      line({
        id: `r${n}`,
        parentId: `a${n}`,
        type: "message",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: call,
          toolName: "read",
          isError: false,
          timestamp: n * 1000 + 2,
          content: [
            { type: "text", text: `Read image file shot-${n}.png` },
            { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
          ],
        },
      });
      line({
        id: `f${n}`,
        parentId: `r${n}`,
        type: "message",
        timestamp,
        message: assistant(n, 3, [{ type: "text", text }], "stop"),
      });
    }
  } finally {
    closeSync(fd);
  }
  const bytes = statSync(path).size;
  if (bytes <= JSONL_RECORD_LIMIT) throw new Error(`long history sample is only ${bytes} bytes`);
  return { path, bytes };
}

/** 旧版逐轮补载/按需原文入口；完整轮分页下任何时候都不能出现。 */
const FRAGMENT_UI = /按需查看内容|加载本轮更多过程|重新加载本轮内容/u;
const LOAD_EARLIER = /^加载更早的对话/u;

async function assertNoFragmentUi(session) {
  const text = await evaluate(session, "document.body.innerText");
  if (FRAGMENT_UI.test(text)) throw new Error("turn fragment/deferred-content UI is visible");
}

/**
 * 像用户一样向上滚动；滚到已加载窗口顶部、按钮进入视口时才点击“加载更早的对话”，
 * 按整轮向前取页，直到目标轮次出现。滚动本身从不触发取页。
 */
async function loadEarlierUntil(session, text, timeoutMs, beforeFirstClick) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let clicks = 0;
  while (Date.now() < deadline) {
    if (await evaluate(session, `document.body.innerText.includes(${JSON.stringify(text)})`)) {
      console.log(`[long-history] "${text}" visible at ${Date.now() - started} ms`);
      return clicks;
    }
    const label = await evaluate(
      session,
      `(() => {
        const viewport = document.querySelector(${JSON.stringify(TIMELINE)}).getBoundingClientRect();
        const button = [...document.querySelectorAll('button')].find((node) => !node.disabled &&
          ${LOAD_EARLIER}.test(node.innerText.trim()));
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom ? button.innerText.trim() : null;
      })()`,
    );
    if (label) {
      if (clicks === 0) await beforeFirstClick?.();
      await clickButton(session, label);
      clicks += 1;
      console.log(`[long-history] clicked "${label}" at ${Date.now() - started} ms`);
      await new Promise((done) => setTimeout(done, 800));
      await assertNoFragmentUi(session);
      continue;
    }
    const point = await evaluate(
      session,
      `(() => { const r = document.querySelector(${JSON.stringify(TIMELINE)}).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -1200,
    });
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`loading earlier turns never revealed "${text}"`);
}

/** 打开长会话并验证首屏、分页与子代理引用；返回可记录的阶段耗时。 */
export async function checkLongHistory(session, capture) {
  await waitForPage(
    session,
    `(window.dispatchEvent(new Event("focus")),
      document.body.innerText.includes(${JSON.stringify(LONG_HISTORY_TITLE)}))`,
    "long history session listed in the sidebar",
    45_000,
  );
  const started = Date.now();
  await clickTaskItem(session, LONG_HISTORY_TITLE);
  await waitForText(
    session,
    `END-OF-ANSWER-${LONG_HISTORY_TURNS}`,
    "complete latest answer",
    60_000,
  );
  const firstMs = Date.now() - started;
  const text = await evaluate(session, "document.body.innerText");
  if (/67108864|JSONL record exceeded/u.test(text))
    throw new Error("long history hit the JSONL record limit");
  if (text.includes("[blocked]")) throw new Error("subagent reference was blocked");
  const link = await evaluate(
    session,
    `[...document.querySelectorAll('a, button')].some((node) => node.innerText.trim() === "Researcher")`,
  );
  if (!link) throw new Error("subagent reference is not rendered as an internal link");
  await assertNoFragmentUi(session);
  // 首屏是最新 20 个完整轮次：其上还有 50 轮。
  const firstPage = await evaluate(
    session,
    `[...document.querySelectorAll('button')].some((node) =>
      node.innerText.trim() === "加载更早的对话（还有 50 轮）")`,
  );
  if (!firstPage) throw new Error("the first screen is not the latest 20 complete turns");
  const clicksTo50 = await loadEarlierUntil(session, "long history prompt 50", 120_000, () =>
    capture?.("13-load-earlier-button"),
  );
  const clicksTo30 = await loadEarlierUntil(session, "long history prompt 30", 120_000);
  if (clicksTo50 < 1) throw new Error("earlier turns appeared without the load-earlier button");
  const answer = await evaluate(session, `document.body.innerText.includes("END-OF-ANSWER-30")`);
  if (!answer) throw new Error("an earlier loaded turn is not complete");
  return { firstMs, clicks: clicksTo50 + clicksTo30 };
}
