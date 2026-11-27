import { describe, expect, it, vi } from "vitest";
import type { NekBuiltinSlashCommandName } from "@zcode/shared/nek-protocol";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { executeBuiltinSlashCommand } from "./builtinSlashActions.js";

type Ports = Parameters<typeof executeBuiltinSlashCommand>[2];
const accepted: CommandAck = { commandId: "action", status: "accepted", revisionAtDecision: 1 };

function fixture(overrides: Partial<Ports> = {}) {
  const calls: Array<readonly unknown[]> = [];
  const ports = {
    sessionId: "s1",
    modelView: {
      revision: 1,
      scope: { patterns: [], models: [], diagnostics: [] },
      providers: [
        {
          providerId: "CPA",
          displayName: "CPA",
          models: [
            {
              modelId: "vendor/model-v1",
              displayName: "Selected",
              reasoningLevels: ["off", "medium", "high"],
              supportsImage: false,
            },
          ],
        },
      ],
    },
    currentSelection: { providerId: "CPA", modelId: "vendor/model-v1" },
    openPicker: vi.fn((picker) => {
      calls.push(["picker", picker]);
      return true;
    }),
    selectModel: vi.fn((provider, model) => {
      calls.push(["model", provider, model]);
    }),
    selectThinking: vi.fn((level) => {
      calls.push(["thinking", level]);
    }),
    openSettings: vi.fn((section) => {
      calls.push(["settings", section]);
      return true;
    }),
    newSession: vi.fn(() => {
      calls.push(["new"]);
      return true;
    }),
    openDialog: vi.fn((kind) => {
      calls.push(["dialog", kind]);
    }),
    rename: vi.fn(async (title) => {
      calls.push(["rename", title]);
    }),
    compact: vi.fn(async (instructions) => {
      calls.push(["compact", instructions]);
      return { ack: accepted, queued: false };
    }),
    readLastAssistantText: vi.fn(async () => {
      calls.push(["readAnswer"]);
      return "last answer\nsecond line";
    }),
    writeClipboard: vi.fn(async (text) => {
      calls.push(["clipboard", text]);
    }),
    reload: vi.fn(async () => {
      calls.push(["reload"]);
      return { reloaded: 2, deferred: 1, failures: [], diagnostics: [] };
    }),
    focusSessionSearch: vi.fn(() => {
      calls.push(["search"]);
      return true;
    }),
    focusFork: vi.fn(() => {
      calls.push(["focusFork"]);
      return true;
    }),
    openTaskArchive: vi.fn((mode) => {
      calls.push(["archive", mode]);
      return true;
    }),
    ...overrides,
  } satisfies Ports;
  return {
    calls,
    execute: (
      name: NekBuiltinSlashCommandName,
      args = "",
      hasAttachments = false,
      isCurrent = () => true,
    ) => executeBuiltinSlashCommand({ name, args }, hasAttachments, ports, isCurrent),
    ports,
  };
}

describe("builtin GUI slash actions", () => {
  it.each([
    ["model", "", ["picker", "model"]],
    ["model", "cpa/vendor/model-v1", ["model", "CPA", "vendor/model-v1"]],
    ["thinking", "", ["picker", "thought"]],
    ["thinking", "HIGH", ["thinking", "high"]],
    ["scoped-models", "", ["settings", "nekDefaultModel"]],
    ["new", "", ["new"]],
    ["name", "", ["dialog", "rename"]],
    ["name", "我的会话", ["rename", "我的会话"]],
    ["session", "", ["dialog", "session"]],
    ["compact", "keep  files\nand tests", ["compact", "keep  files\nand tests"]],
    ["compact", "", ["compact", undefined]],
    ["settings", "", ["settings", undefined]],
    ["hotkeys", "", ["settings", "nekShortcuts"]],
    ["login", "anthropic", ["settings", "nekAccounts"]],
    ["logout", "", ["settings", "nekAccounts"]],
    ["trust", "", ["settings", "nekProject"]],
    ["resume", "", ["search"]],
    ["fork", "", ["focusFork"]],
  ] as const)("SC-3 routes /%s %s to the existing GUI action", async (name, args, call) => {
    const { calls, execute } = fixture();
    expect((await execute(name, args)).status).toBe("sent");
    expect(calls).toEqual([call]);
  });

  it("SC-3 reports unknown models and lists the current model's supported thinking levels", async () => {
    const { calls, execute } = fixture();
    expect(await execute("model", "CPA/unknown")).toMatchObject({
      status: "blocked",
      notice: { id: "chat.slash.unknownModel", values: { model: "CPA/unknown" } },
    });
    expect(await execute("thinking", "max")).toMatchObject({
      status: "blocked",
      notice: {
        id: "chat.slash.unknownThinking",
        values: { level: "max", levels: "off, medium, high" },
      },
    });
    expect(calls).toEqual([]);
  });

  it("SC-3 /copy writes the authoritative text, and reports an empty answer without writing", async () => {
    const present = fixture();
    expect(await present.execute("copy")).toMatchObject({
      status: "sent",
      notice: { id: "chat.slash.copied" },
    });
    expect(present.calls).toEqual([["readAnswer"], ["clipboard", "last answer\nsecond line"]]);
    const empty = fixture({ readLastAssistantText: async () => null });
    expect(await empty.execute("copy")).toMatchObject({
      status: "blocked",
      notice: { id: "chat.slash.noAnswer" },
    });
    expect(empty.ports.writeClipboard).not.toHaveBeenCalled();
  });

  it("SC-3 /copy discards an answer returned for a retired pane binding", async () => {
    const { execute, ports } = fixture();
    expect(await execute("copy", "", false, () => false)).toEqual({ status: "blocked" });
    expect(ports.writeClipboard).not.toHaveBeenCalled();
  });

  it("SC-3 /reload reports reloaded and deferred counts and leaves failures retryable", async () => {
    const working = fixture();
    expect(await working.execute("reload")).toMatchObject({
      status: "sent",
      notice: { id: "settings.nek.advanced.reloadResult", values: { reloaded: 2, deferred: 1 } },
    });
    expect(working.calls).toEqual([["reload"]]);
    const announced = fixture({
      reload: async () => ({
        announced: true,
        reloaded: 0,
        deferred: 0,
        diagnostics: [],
        failures: [],
      }),
    });
    expect(await announced.execute("reload")).toMatchObject({
      status: "sent",
      notice: { id: "settings.nek.machineReload.requested" },
    });
    const failed = fixture({
      reload: async () => ({
        reloaded: 0,
        deferred: 0,
        diagnostics: [],
        failures: [{ sessionKey: "s1", message: "timed out" }],
      }),
    });
    expect(await failed.execute("reload")).toMatchObject({
      status: "blocked",
      notice: {
        id: "settings.nek.reload.failed",
        values: { count: 1, reason: "timed out" },
      },
    });
  });

  it.each(["export", "import"] as const)(
    "NA-5 /%s opens the shared archive action only without arguments or attachments",
    async (name) => {
      const { calls, execute } = fixture();
      expect(await execute(name, "archive.jsonl")).toMatchObject({
        status: "blocked",
        notice: { id: "taskArchive.slashNoArgs", values: { name } },
      });
      expect(await execute(name, "", true)).toMatchObject({
        status: "blocked",
        notice: { id: "chat.slash.attachmentsBlocked" },
      });
      expect(calls).toEqual([]);
      expect(await execute(name)).toEqual({ status: "sent" });
      expect(calls).toEqual([["archive", name]]);
    },
  );

  it("NA-5 /import works from a draft but /export requires an active task", async () => {
    const draft = fixture({ sessionId: null, modelView: null });
    expect(await draft.execute("export")).toMatchObject({
      status: "blocked",
      notice: { id: "taskArchive.noTask" },
    });
    expect(await draft.execute("import")).toEqual({ status: "sent" });
    expect(draft.calls).toEqual([["archive", "import"]]);
  });

  it.each(["tree", "share", "clone", "changelog"] as const)(
    "SC-3 /%s only shows the planned notice and keeps the draft",
    async (name) => {
      const { calls, execute } = fixture();
      expect(await execute(name, "some argument")).toMatchObject({
        status: "blocked",
        notice: { id: "chat.slash.planned", values: { name } },
      });
      expect(calls).toEqual([]);
    },
  );

  it("SC-3 /quit is just a close-window hint, never a shutdown", async () => {
    const { calls, execute } = fixture();
    expect(await execute("quit")).toMatchObject({
      status: "blocked",
      notice: { id: "chat.slash.quitHint" },
    });
    expect(calls).toEqual([]);
  });

  it("SC-2 rejects attached builtin input without consuming attachments or running a GUI action", async () => {
    const { calls, execute } = fixture();
    expect(await execute("model", "", true)).toMatchObject({
      status: "blocked",
      notice: { id: "chat.slash.attachmentsBlocked" },
    });
    expect(calls).toEqual([]);
  });
});
