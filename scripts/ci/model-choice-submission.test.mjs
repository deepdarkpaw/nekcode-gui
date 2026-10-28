import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const pane = "packages/ui/src/v4/SessionPane.tsx";
const selection = Object.freeze({
  providerId: "fixture-api",
  modelId: "fixture-model",
  options: { reasoningLevel: "high" },
});
const forbidden = () => {
  throw new Error("Retired plan recommendation must not run");
};

test("old recommendation preference is discarded without changing local settings", async () => {
  const { appSettingsSchema, appSettingsPatchSchema } = await tsImport(
    "../../packages/shared/src/validationAppSettings.ts",
    import.meta.url,
  );
  const old = {
    startPlanRecommendationDismissed: true,
    locale: "en-US",
    httpProxy: "http://fixture.invalid:8080",
  };
  for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
    const result = schema.parse(old);
    assert.equal(Object.hasOwn(result, "startPlanRecommendationDismissed"), false);
    assert.equal(result.locale, old.locale);
    assert.equal(result.httpProxy, old.httpProxy);
  }
});

test("chat submission keeps the frozen model and existing admission guards without plan IO", async () => {
  for (const status of ["accepted", "rejected", "choice", "not-ready"]) {
    const commands = [];
    const callback = await loadComponentCallback(pane, "dispatchSendTextAfterConfig", {
      recommendStartPlan: forbidden,
      captureAcceptedModelSelection: forbidden,
      dispatchCommand: async (...args) => {
        commands.push(args);
        return { status, reasonCode: status === "rejected" ? "fixture-rejection" : undefined };
      },
      parseV4VisibleSlashCommand: () => null,
      ensureDraftModelReadyForSend: async () => status !== "not-ready",
      sessionId: "fixture-session",
      appSlashCommands: [],
      snapshotRef: {
        current: { inputRouting: { mode: status === "choice" ? "choice" : "queue" } },
      },
      submissionConfigFromCommand: (_type, payload) => payload,
      logger: { warn: forbidden },
    });
    const input = {
      submission: Object.freeze({ modelSelection: selection, mode: "build", planEnabled: false }),
    };
    if (status === "rejected")
      await assert.rejects(callback("Fixture question", input), /fixture-rejection/);
    else {
      const result = await callback("Fixture question", input);
      assert.equal(
        result,
        status === "choice"
          ? "confirmationRequired"
          : status === "not-ready"
            ? "blocked"
            : undefined,
      );
    }
    assert.equal(commands.length, status === "choice" || status === "not-ready" ? 0 : 1);
    if (commands.length) {
      assert.equal(commands[0][0], "sendText");
      assert.equal(commands[0][1].modelSelection, selection);
      assert.equal(commands[0][2], "fixture-session");
    }
    assert.equal(input.submission.modelSelection, selection);
  }
});

test("side conversation delegates model inheritance to its parent Host and keeps workspace identity", async () => {
  const commands = [],
    opened = [];
  const callback = await loadComponentCallback(
    pane,
    "handleOpenSelectionSideConversationWithPrompt",
    {
      recommendStartPlan: forbidden,
      resolveSelectionSideInheritedModel: () => selection,
      snapshotRef: { current: { config: {} } },
      modelSelectionView: {},
      sessionId: "parent",
      selectionSideChatKey: "fixture-key",
      onOpenSelectionSideChat: (input) => opened.push(input),
      createSelectionSideChat: async (_key, run) => run(),
      dispatchCommand: async (...args) => {
        commands.push(args);
        return {
          status: "accepted",
          result: { type: "createSelectionSideSession", sessionId: "child" },
        };
      },
      workspacePath: "/fixture/workspace",
      workspaceIdentity: "fixture-remote",
      remoteSessionId: "fixture-attachment",
    },
  );
  assert.equal(await callback("Fixture side question"), true);
  assert.deepEqual(commands[0].slice(0, 3), [
    "createSelectionSideSession",
    { firstInput: { text: "Fixture side question" } },
    "parent",
  ]);
  assert.deepEqual(opened, [
    {
      workspacePath: "/fixture/workspace",
      workspaceIdentity: "fixture-remote",
      remoteSessionId: "fixture-attachment",
      parentSessionId: "parent",
      childSessionId: "child",
    },
  ]);
});
