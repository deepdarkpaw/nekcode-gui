import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultExecutable } from "../acceptance/lib/app.mjs";
import {
  MOCK_FIRST_PROMPT,
  MOCK_LONG_PROMPT,
  MOCK_OTHER_ANSWER,
  MOCK_PLAN_TITLE,
  pickMockTurn,
  startMockLlm,
} from "../acceptance/lib/mockLlm.mjs";

const user = (content) => ({ role: "user", content });
const tool = (tool_call_id, content) => ({ role: "tool", tool_call_id, content });
const body = (messages) => JSON.stringify({ messages });

test("mock routes only the latest user turn, not a previous completed tool chain", () => {
  const history = [user(MOCK_FIRST_PROMPT), tool("call_switch", "You are now in Plan mode.")];
  assert.equal(pickMockTurn(body(history)), "plan");
  assert.equal(pickMockTurn(body([...history, user(MOCK_LONG_PROMPT)])), "slow");
  assert.equal(pickMockTurn(body([...history, user(MOCK_FIRST_PROMPT)])), "first");
  assert.equal(
    pickMockTurn(body([...history, user(`Implement the plan.\n${MOCK_PLAN_TITLE}`)])),
    "final",
  );
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
  assert.equal(pickMockTurn(body(history)), "final");
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
