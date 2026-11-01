import assert from "node:assert/strict";
import test from "node:test";
import { NEK_STRUCTURED_KINDS } from "@zcode/shared/nek-protocol";
import type { NekConfigTarget, NekLoginEvent } from "@zcode/shared/nek-protocol";
import { FakeControlClient, LOCAL, REMOTE, createHarness } from "./nekConfigApiHarness.js";

/**
 * 登录事件流的两条硬约束：
 * - `startLogin` 返回后界面才订阅，所以订阅时必须**回放**已经发生过的事件；
 * - structured 请求 → `prompt`，撤销 → `prompt_cancelled`，`auth_event` → `auth_event`。
 */

test("remote OAuth login forwards its callback port and releases it after completion", async () => {
  const control = new FakeControlClient();
  const calls: Array<{ target: NekConfigTarget; ports: number[] }> = [];
  let closed = 0;
  const harness = createHarness({
    control,
    forwardLoginPorts: async (target, ports) => {
      calls.push({ target, ports });
      return {
        ports,
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  const session = await harness.api.startLogin(REMOTE, "anthropic");
  assert.deepEqual(session.forwardedPorts, [53692]);
  assert.deepEqual(calls, [{ target: REMOTE, ports: [53692] }]);
  assert.equal(closed, 0);

  control.completeLogin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
});

test("login events are replayed to a late subscriber", async () => {
  const control = new FakeControlClient();
  const harness = createHarness({ control });
  const session = await harness.api.startLogin(LOCAL, "anthropic");
  assert.match(session.loginId, /^login-/);
  assert.deepEqual(session.forwardedPorts, [], "local target needs no port forwarding");

  const event = (record: unknown): NekLoginEvent => ({
    type: "auth_event",
    record: record as Extract<NekLoginEvent, { type: "auth_event" }>["record"],
  });
  // 在订阅之前就发生的事件：auth_url + 一个输入提示。
  control.emitAuthEvent({
    type: "auth_event",
    provider: "anthropic",
    event: { type: "auth_url", url: "https://auth.example.com/oauth", instructions: "open it" },
  });
  const promptRequest = {
    type: "extension_ui_request" as const,
    id: "prompt-1",
    method: "structured" as const,
    kind: NEK_STRUCTURED_KINDS.authPrompt,
    payload: {
      provider: "anthropic",
      prompt: { type: "manual_code", message: "Paste the code" },
    },
  };
  const pending = control.pushPrompt(promptRequest);

  const received: NekLoginEvent[] = [];
  const unsubscribe = harness.api.onLoginEvent(session.loginId, (loginEvent) =>
    received.push(loginEvent),
  );

  // 回放：两个事件都在，顺序与发生顺序一致。
  assert.equal(received.length, 2);
  assert.equal(received[0]?.type, "auth_event");
  assert.equal(received[1]?.type, "prompt");
  const promptEvent = received[1];
  assert.ok(promptEvent?.type === "prompt");
  assert.equal(promptEvent.promptId, "prompt-1");
  assert.equal(promptEvent.payload.prompt.type, "manual_code");
  assert.deepEqual(
    received[0]?.type === "auth_event" ? received[0].record.event.type : undefined,
    "auth_url",
  );

  // 答复提示：变成一条 extension_ui_response，并发出 prompt_cancelled 关闭对话框。
  await harness.api.answerLoginPrompt(session.loginId, "prompt-1", "code#state");
  const answered = await pending;
  assert.deepEqual(answered, {
    type: "extension_ui_response",
    id: "prompt-1",
    result: { value: "code#state" },
  });
  assert.equal(received.filter((event) => event.type === "prompt_cancelled").length, 1);

  control.completeLogin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1)?.type, "done");

  // 订阅之后又收到的事件只推送一次（不重复回放）。
  const late: NekLoginEvent[] = [];
  const detach = harness.api.onLoginEvent(session.loginId, (loginEvent) => late.push(loginEvent));
  detach();
  assert.equal(late.length, received.length);
  unsubscribe();
  void event;
});

test("cancelling a login resolves the pending prompt and emits cancelled", async () => {
  const control = new FakeControlClient();
  const harness = createHarness({ control });
  const session = await harness.api.startLogin(LOCAL, "openai-codex");
  const events: NekLoginEvent[] = [];
  harness.api.onLoginEvent(session.loginId, (event) => events.push(event));
  const pending = control.pushPrompt({
    type: "extension_ui_request",
    id: "prompt-2",
    method: "structured",
    kind: NEK_STRUCTURED_KINDS.authPrompt,
    payload: { provider: "openai-codex", prompt: { type: "text", message: "user code" } },
  });
  await harness.api.cancelLogin(session.loginId);
  const response = await pending;
  assert.deepEqual(response, { type: "extension_ui_response", id: "prompt-2", cancelled: true });
  assert.equal(events.at(-1)?.type, "cancelled");
  // 结束之后再答复是校验错误，不是静默丢弃。
  await assert.rejects(
    async () => await harness.api.answerLoginPrompt(session.loginId, "prompt-2", "x"),
    (error: unknown) => (error as { code?: string }).code === "validation",
  );
});

test("a failed login surfaces the nek error message", async () => {
  const control = new FakeControlClient();
  const harness = createHarness({ control });
  const session = await harness.api.startLogin(LOCAL, "anthropic");
  const events: NekLoginEvent[] = [];
  harness.api.onLoginEvent(session.loginId, (event) => events.push(event));
  control.failLogin("invalid_grant: code expired");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failure = events.at(-1);
  assert.ok(failure?.type === "failed");
  assert.match(failure.message, /invalid_grant/);
});

test("unexpected structured requests during a login are cancelled, not left hanging", async () => {
  const control = new FakeControlClient();
  const harness = createHarness({ control });
  await harness.api.startLogin(LOCAL, "anthropic");
  const response = await control.pushPrompt({
    type: "extension_ui_request",
    id: "ask-1",
    method: "structured",
    kind: NEK_STRUCTURED_KINDS.askQuestion,
    payload: { questions: [] },
  });
  assert.deepEqual(response, { type: "extension_ui_response", id: "ask-1", cancelled: true });
});

test("auth status and logout go through the control process", async () => {
  const control = new FakeControlClient({
    authStatus: [
      {
        provider: "anthropic",
        name: "Anthropic",
        kind: "oauth",
        loginMethods: ["oauth"],
        expiresAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const harness = createHarness({ control });
  const statuses = await harness.api.getAuthStatus(LOCAL);
  assert.equal(statuses[0]?.kind, "oauth");
  assert.equal(statuses[0]?.state, "expired", "a past expiresAt becomes expired");
  await harness.api.logout(LOCAL, "anthropic");
  assert.deepEqual(
    control.commands.map((command) => command.type),
    ["auth_status", "auth_logout"],
  );
});

test("auth status maps the fields nek actually returns", async () => {
  const control = new FakeControlClient({
    authStatus: [
      {
        provider: "anthropic",
        name: "Anthropic",
        kind: "oauth",
        loginMethods: ["oauth"],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      { provider: "openai-codex", name: "Codex", kind: "api_key", loginMethods: ["api_key"] },
      { provider: "other", name: "Other", kind: "none", loginMethods: [] },
    ],
  });
  const harness = createHarness({ control });
  const statuses = await harness.api.getAuthStatus(LOCAL);
  assert.deepEqual(
    statuses.map((status) => [status.provider, status.state]),
    [
      ["anthropic", "ok"],
      ["openai-codex", "ok"],
      ["other", "ok"],
    ],
  );
  // 早于 P2c 的 nek 不返回 state：host 不会凭空造出 refresh_failed。
  assert.equal(
    statuses.some((status) => status.state === "refresh_failed"),
    false,
  );
});

test("auth status keeps the state nek computed", async () => {
  const control = new FakeControlClient({
    authStatus: [
      {
        provider: "anthropic",
        name: "Anthropic",
        kind: "oauth",
        // nek 已按 expires <= now 判定：值就是最终结论，host 不再重新推导。
        expiresAt: "2026-01-01T00:00:00Z",
        state: "ok",
        loginMethods: ["oauth"],
      },
      {
        provider: "future",
        name: "Future",
        kind: "oauth",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        state: "expired",
        loginMethods: ["oauth"],
      },
    ],
  });
  const harness = createHarness({ control });
  const statuses = await harness.api.getAuthStatus(LOCAL);
  assert.deepEqual(
    statuses.map((status) => [status.provider, status.state]),
    [
      ["anthropic", "ok"],
      ["future", "expired"],
    ],
  );
});
