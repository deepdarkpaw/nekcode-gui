import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultExecutable, removeSandbox, stopApp } from "../acceptance/lib/app.mjs";
import {
  MOCK_CLI_PROMPT,
  MOCK_CLI_REPLY,
  MOCK_FIRST_PROMPT,
  MOCK_IMAGE_FOLLOWUP_PROMPT,
  MOCK_IMAGE_FOLLOWUP_REPLY,
  MOCK_IMAGE_PROMPT,
  MOCK_IMAGE_REPLY,
  MOCK_LONG_PROMPT,
  MOCK_FILE_PROMPT,
  MOCK_QUEUE_PROMPT,
  MOCK_OTHER_ANSWER,
  MOCK_PLAN_TITLE,
  listenOnFetchablePort,
  pickMockTurn,
  startMockLlm,
} from "../acceptance/lib/mockLlm.mjs";

const user = (content) => ({ role: "user", content });
const tool = (tool_call_id, content) => ({ role: "tool", tool_call_id, content });
const body = (messages) => JSON.stringify({ messages });

test("file flow accepts real edit result wording and queued user input starts a fresh turn", () => {
  const prefix = [user(MOCK_FILE_PROMPT)];
  assert.equal(pickMockTurn(body(prefix)), "streamWrite");
  assert.equal(
    pickMockTurn(body([...prefix, tool("call_stream_write", "Successfully wrote to fixture")])),
    "editOne",
  );
  assert.equal(
    pickMockTurn(
      body([...prefix, tool("call_edit_one", "The file has been updated successfully.")]),
    ),
    "editTwo",
  );
  assert.throws(
    () => pickMockTurn(body([...prefix, tool("call_edit_one", "Edit failed")])),
    /file operation failed/,
  );
  assert.equal(pickMockTurn(body([...prefix, user(MOCK_QUEUE_PROMPT)])), "queued");
});

test("a completed slow mock stream has a finish_reason, so queue draining is not replaced by retries", async () => {
  const mock = await startMockLlm({ slowChunks: 2, slowDelayMs: 1 });
  try {
    const response = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: body([user(MOCK_LONG_PROMPT)]),
    });
    assert.match(await response.text(), /"finish_reason":"stop"/);
  } finally {
    await mock.close();
  }
});

test("mock routes only the latest user turn, not a previous completed tool chain", () => {
  const history = [user(MOCK_FIRST_PROMPT), tool("call_switch", "You are now in Plan mode.")];
  assert.equal(pickMockTurn(body(history)), "plan");
  assert.equal(pickMockTurn(body([...history, user(MOCK_LONG_PROMPT)])), "slow");
  assert.equal(pickMockTurn(body([...history, user(MOCK_FIRST_PROMPT)])), "first");
  const implementing = [...history, user(`Implement the plan.\n${MOCK_PLAN_TITLE}`)];
  assert.equal(pickMockTurn(body(implementing)), "todos");
  // 待办全部标为完成之后才给最终回复，nek 不会再追加“仍有未完成待办”的提醒。
  assert.equal(pickMockTurn(body([...implementing, tool("call_todos", "2 of 2 done")])), "final");
});

test("nek reminder-only user messages do not hide the approved implementation or a later user turn", () => {
  const reminder = user([
    { type: "text", text: "<system_reminder>Mode changed.</system_reminder>" },
  ]);
  const history = [
    user(MOCK_FIRST_PROMPT),
    tool("call_switch", "You are now in Plan mode."),
    user(`Implement the plan.\n${MOCK_PLAN_TITLE}`),
    reminder,
  ];
  assert.equal(pickMockTurn(body(history)), "todos");
  assert.equal(pickMockTurn(body([...history, user(MOCK_LONG_PROMPT), reminder])), "slow");
  assert.throws(() => pickMockTurn(body([...history, user("unexpected user input"), reminder])));
});

test("mock verifies both question answers and actual mode approval before continuing", () => {
  const prefix = [user(MOCK_FIRST_PROMPT)];
  assert.equal(pickMockTurn(body([...prefix, tool("call_ls", "README.md")])), "ask");
  assert.equal(
    pickMockTurn(body([...prefix, tool("call_ask", `q1: Redis\nq2: other: ${MOCK_OTHER_ANSWER}`)])),
    "switch",
  );
  assert.throws(
    () => pickMockTurn(body([...prefix, tool("call_ask", "User dismissed the questions.")])),
    /expected question answers/u,
  );
  assert.throws(
    () => pickMockTurn(body([...prefix, tool("call_switch", "User declined the mode switch.")])),
    /approved mode switch/u,
  );
  assert.throws(() => pickMockTurn("{"), SyntaxError);
  assert.throws(() => pickMockTurn(body([user("unrecognized")])));
});

test("mock records stream abort before cleanup, not ordinary successful completion", async () => {
  const mock = await startMockLlm({ slowChunks: 100, slowDelayMs: 20 });
  try {
    const normal = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: body([user(MOCK_FIRST_PROMPT)]),
    });
    assert.equal(normal.status, 200);
    assert.match(await normal.text(), /tool_calls/u);
    assert.equal(mock.requests[0].aborted, false);
    const abort = new AbortController();
    const stream = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: body([user(MOCK_LONG_PROMPT)]),
      signal: abort.signal,
    });
    const reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false);
    abort.abort();
    const deadline = Date.now() + 2_000;
    while (!mock.requests[1].aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(mock.requests[1].turn, "slow");
    assert.equal(mock.requests[1].aborted, true);
    assert.equal(mock.requests[0].aborted, false);
  } finally {
    await mock.close();
  }
});

test("mock answers the CLI, pasted-image and follow-up turns and records whether an image arrived", async () => {
  const mock = await startMockLlm();
  const send = async (messages) => {
    const response = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: body(messages),
    });
    assert.equal(response.status, 200);
    return await response.text();
  };
  const reply = (text) => new RegExp(text.replaceAll(".", "\\."), "u");
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const imageTurn = user([{ type: "text", text: MOCK_IMAGE_PROMPT }, image]);
  try {
    assert.match(await send([user(MOCK_CLI_PROMPT)]), reply(MOCK_CLI_REPLY));
    assert.match(await send([imageTurn]), reply(MOCK_IMAGE_REPLY));
    await send([user([{ type: "text", text: MOCK_IMAGE_PROMPT }])]);
    // 追问只看最新用户回合：历史里已经发过的图片不算，重新带上的图片才算。
    assert.match(
      await send([imageTurn, user(MOCK_IMAGE_FOLLOWUP_PROMPT)]),
      reply(MOCK_IMAGE_FOLLOWUP_REPLY),
    );
    await send([imageTurn, user([{ type: "text", text: MOCK_IMAGE_FOLLOWUP_PROMPT }, image])]);
    assert.deepEqual(
      mock.requests.map(({ turn, hasImage }) => ({ turn, hasImage })),
      [
        { turn: "cli", hasImage: false },
        { turn: "image", hasImage: true },
        { turn: "image", hasImage: false },
        { turn: "imageFollowup", hasImage: false },
        { turn: "imageFollowup", hasImage: true },
      ],
    );
  } finally {
    await mock.close();
  }
});

test("mock rejects malformed or oversized requests instead of replying with a success fallback", async () => {
  const mock = await startMockLlm();
  try {
    const invalid = await fetch(`${mock.baseUrl}/chat/completions`, { method: "POST", body: "{" });
    assert.equal(invalid.status, 400);
    await invalid.text();
    const large = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: "x".repeat(300 * 1024),
    });
    assert.equal(large.status, 413);
    await large.text();
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].turn, "invalid");
    assert.equal(typeof mock.requests[0].error, "string");
  } finally {
    await mock.close();
  }
});

test("mock never listens on a port that fetch refuses (nek would report Connection error)", async () => {
  /** 模拟系统分配：被占住的端口不会再分配出去。 */
  const held = new Set();
  const offers = [6000, 10080, 41234];
  const stubServer = (bound = []) => ({
    port: 0,
    once() {},
    off() {},
    listen(port, _host, callback) {
      this.port = port === 0 ? offers.find((offer) => !held.has(offer)) : port;
      if (port !== 0) held.add(port);
      bound.push(this.port);
      callback();
    },
    address() {
      return { port: this.port };
    },
    close(callback) {
      held.delete(this.port);
      callback?.();
    },
  });
  const placeholders = [];
  const port = await listenOnFetchablePort(stubServer(), () => stubServer(placeholders));
  assert.equal(port, 41234);
  assert.deepEqual(placeholders, [6000, 10080]);
  assert.equal(held.size, 0, "placeholders must be released once a usable port is bound");
  const refused = await fetch("http://127.0.0.1:6000/").catch((error) => error.cause?.message);
  assert.equal(refused, "bad port");
});

test("packaged entry detection returns Linux path and refuses ambiguous Windows flavors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekcode-entry-test-"));
  try {
    for (const folder of ["linux-unpacked", "win-unpacked"]) await mkdir(join(root, folder));
    await writeFile(join(root, "linux-unpacked/nekcode"), "");
    await mkdir(join(root, "linux-unpacked/nekcode-resources"));
    assert.equal(defaultExecutable(root, "linux"), join(root, "linux-unpacked/nekcode"));
    await writeFile(join(root, "win-unpacked/nekcode.exe"), "");
    assert.equal(defaultExecutable(root, "win32"), join(root, "win-unpacked/nekcode.exe"));
    await writeFile(join(root, "win-unpacked/nekcode-preview.exe"), "");
    assert.throws(() => defaultExecutable(root, "win32"), /found 2/u);
    assert.throws(() => defaultExecutable(root, "darwin"), /pass --app/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopApp resolves only after the app process exited, then the sandbox can be removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "nekcode-stop-test-"));
  const held = join(root, "held.sqlite");
  // 子进程打开沙箱里的文件后常驻，模拟应用持有 SQLite 句柄；与 launchApp 一样在 POSIX 上独立进程组。
  const script = `require("fs").openSync(${JSON.stringify(held)}, "w"); process.stdout.write("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  await stopApp(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "stopApp returned before exit");
  // 已退出的进程再次 stop 是空操作。
  await stopApp(child);
  await removeSandbox({ root });
  await assert.rejects(stat(root), { code: "ENOENT" });
});
