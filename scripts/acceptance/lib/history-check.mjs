/**
 * 长历史验收：在沙箱 agentDir 写入 70 轮、累计超过 64 MB 的会话，从侧栏打开，
 * 证明首帧不触发 JSONL 单条上限、最新一页可见、向上滚动按页取回更早轮次，且子代理引用不被拦截。
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate, waitForPage } from "./cdp.mjs";
import { clickTaskItem, waitForText } from "./ui.mjs";

const LONG_HISTORY_TURNS = 70;
const LONG_HISTORY_TITLE = "long history prompt 1";
const JSONL_RECORD_LIMIT = 64 * 1024 * 1024;
const SUBAGENT_ID = "0f8e4a52-6b1d-4c3e-9a7f-2d5b8c1e4f60";
const TIMELINE = '[data-testid="v4-timeline"]';
/** 每轮约 1.1 MB 的多字节回答，使 70 轮累计超过 64 MB。 */
const GIANT = "界😀".repeat(160_000);

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
  try {
    line({ type: "session", version: 3, id, timestamp, cwd: resolve(sandbox.project) });
    for (let n = 1; n <= LONG_HISTORY_TURNS; n += 1) {
      const last = n === LONG_HISTORY_TURNS;
      const text = last
        ? `long history answer ${n}, see [Researcher](${SUBAGENT_ID})`
        : `long history answer ${n} ${GIANT}`;
      line({
        id: `u${n}`,
        parentId: n === 1 ? null : `a${n - 1}`,
        type: "message",
        timestamp,
        message: { role: "user", content: `long history prompt ${n}`, timestamp: n * 1000 },
      });
      line({
        id: `a${n}`,
        parentId: `u${n}`,
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "mock",
          model: "offline",
          timestamp: n * 1000 + 1,
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: { ...usage, cost },
        },
      });
    }
  } finally {
    closeSync(fd);
  }
  const bytes = statSync(path).size;
  if (bytes <= JSONL_RECORD_LIMIT) throw new Error(`long history sample is only ${bytes} bytes`);
  return { path, bytes };
}

/** 在时间线上向上滚动，直到出现目标轮次；只由用户滚动驱动取页。 */
async function scrollUntil(session, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(session, `document.body.innerText.includes(${JSON.stringify(text)})`))
      return;
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
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`scrolling up never revealed "${text}"`);
}

/** 打开长会话并验证首屏、分页与子代理引用；返回可记录的阶段耗时。 */
export async function checkLongHistory(session) {
  await waitForPage(
    session,
    `(window.dispatchEvent(new Event("focus")),
      document.body.innerText.includes(${JSON.stringify(LONG_HISTORY_TITLE)}))`,
    "long history session listed in the sidebar",
    45_000,
  );
  const started = Date.now();
  await clickTaskItem(session, LONG_HISTORY_TITLE);
  await waitForText(session, `long history answer ${LONG_HISTORY_TURNS}`, "latest turn", 60_000);
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
  await scrollUntil(session, "long history prompt 50", 60_000);
  await scrollUntil(session, "long history prompt 30", 60_000);
  return { firstMs };
}
