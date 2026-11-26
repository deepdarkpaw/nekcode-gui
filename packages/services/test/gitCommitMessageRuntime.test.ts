import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { appSettingsSchema, appSettingsPatchSchema } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/shared/model-selection-resolution";
import {
  createNekCommitMessageRuntime,
  selectGitMessageModel,
} from "../src/git/nekCommitMessageRuntime.js";
import type { NekRpcProcess, NekRpcProcessOptions } from "../src/nek-agent/nekRpcProcess.js";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { createGitService } from "../src/git/gitService.js";

const chat = { providerId: "dev", modelId: "chat" };
const git = { providerId: "dev", modelId: "summary" };
const view = { preferredSelection: chat, effectiveSelection: git } as ModelSelectionView;

test("Git service persists only its model reference on its own host and can reset to default", async () => {
  let settings = appSettingsSchema.parse({});
  const service = createGitService({
    settings: {
      get: async () => settings,
      update: async (patch) => {
        settings = appSettingsSchema.parse({ ...settings, ...appSettingsPatchSchema.parse(patch) });
      },
    },
  });
  await service.setCommitMessageModel(git);
  assert.deepEqual(selectGitMessageModel(view, await service.getCommitMessageModel()), git);
  assert.throws(
    () => selectGitMessageModel({ ...view, effectiveSelection: null }, git),
    /dev\/summary/,
  );
  await service.setCommitMessageModel(null);
  assert.deepEqual(selectGitMessageModel(view, await service.getCommitMessageModel()), chat);
});

for (const scenario of ["ok", "wrong model", "provider error", "early exit"] as const)
  test(`isolated Git RPC: ${scenario}`, async () => {
    const events = new EventEmitter();
    const calls: string[] = [];
    let disposed = 0;
    const spawn = (options: NekRpcProcessOptions) => {
      assert.equal(options.approve, false);
      assert.equal(options.cwd, "/project");
      for (const flag of ["--no-session", "--no-tools", "--no-extensions"])
        assert.ok(options.extraArgs?.includes(flag));
      return {
        dispose: async () => {
          disposed++;
        },
        client: {
          onEvent: (type: string, fn: (e: unknown) => void) => {
            events.on(type, fn);
            return () => events.off(type, fn);
          },
          onExit: (fn: () => void) => {
            events.on("exit", fn);
            return () => events.off("exit", fn);
          },
          call: async (command: { type: string; message?: string }) => {
            calls.push(command.type);
            if (command.type === "get_state")
              return {
                model: { provider: "dev", id: scenario === "wrong model" ? "chat" : "summary" },
              };
            if (command.type === "prompt") {
              assert.equal(command.message, "diff fixture");
              if (scenario === "early exit") events.emit("exit");
              else {
                if (scenario === "provider error")
                  events.emit("message_end", { message: { errorMessage: "fixture 503" } });
                events.emit("agent_settled", {
                  outcome: scenario === "ok" ? "completed" : "error",
                });
              }
              return {};
            }
            assert.equal(command.type, "get_last_assistant_text");
            return { text: "fix: keep selected model" };
          },
        },
      } as unknown as NekRpcProcess;
    };
    const runtime = createNekCommitMessageRuntime(
      undefined,
      { locate: async () => ({ info: {} as NekGuiInfo, launcherPath: "fixture", cached: false }) },
      spawn,
    );
    const result = runtime.generateText({
      workspacePath: "/project",
      selection: git,
      prompt: "diff fixture",
    });
    if (scenario === "ok")
      assert.deepEqual(await result, { text: "fix: keep selected model", selection: git });
    else
      await assert.rejects(
        result,
        scenario === "provider error"
          ? /fixture 503/
          : scenario === "early exit"
            ? /exited/
            : /requested model/,
      );
    if (scenario === "wrong model") assert.deepEqual(calls, ["get_state"]);
    assert.equal(disposed, 1);
    assert.equal(events.eventNames().length, 0);
  });
