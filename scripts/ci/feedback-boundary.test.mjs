import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { hostIncomingMessageSchema, hostResponseMessageSchema, taskNotificationPayloadSchema } =
  await tsImport("../../packages/shared/src/validation.ts", import.meta.url);

test("Host boundaries reject removed feedback archive commands in both directions", () => {
  assert.equal(
    hostResponseMessageSchema.safeParse({
      type: "feedback-log-archive-request",
      requestId: "fixture",
      sourceDir: "/private/workspace",
    }).success,
    false,
  );
  assert.equal(
    hostIncomingMessageSchema.safeParse({
      type: "feedback-log-archive-result",
      requestId: "fixture",
      ok: true,
      path: "/private/archive.zip",
      size: 123,
    }).success,
    false,
  );
});

test("Host initialization does not propagate obsolete feedback endpoints or device identity", () => {
  const init = {
    type: "init-local",
    zcodeBuiltinProviderConfigFilePath: "/bundled/provider.json",
    workspacePath: "/workspace",
    workspaceIdentity: "fixture-identity",
  };
  assert.deepEqual(
    hostIncomingMessageSchema.parse({
      ...init,
      deviceMid: "private-device",
      feedbackApiBase: "https://private.example",
    }),
    init,
  );
});

test("task notifications keep only execution and elicitation states without ticket updates", () => {
  const notification = { taskId: "fixture", title: "title", body: "body" };
  for (const status of ["completed", "failed", "elicitation_request"]) {
    assert.equal(
      taskNotificationPayloadSchema.safeParse({ ...notification, status }).success,
      true,
    );
  }
  // 逐工具权限审批通道已删除，任务通知不再有 permission_request 状态。
  for (const status of ["permission_request", "feedback_update"]) {
    assert.equal(
      taskNotificationPayloadSchema.safeParse({ ...notification, status }).success,
      false,
      `${status} 不应再被任务通知接受`,
    );
  }
});
