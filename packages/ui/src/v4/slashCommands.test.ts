import { NEK_BUILTIN_SLASH_COMMANDS } from "@zcode/shared/nek-protocol";
import { describe, expect, it, vi } from "vitest";
import { parseV4VisibleSlashCommand, routeNekSlashSubmission } from "./slashCommands.js";

describe("visible slash commands", () => {
  it.each(NEK_BUILTIN_SLASH_COMMANDS)(
    "SC-2 never calls sendText for /$name, even when the GUI action is blocked",
    ({ name }) => {
      const sendText = vi.fn();
      const runBuiltin = vi.fn(() => "blocked");
      expect(
        routeNekSlashSubmission(` \t/${name}\tfirst  line\nsecond  `, runBuiltin, sendText),
      ).toBe("blocked");
      expect(runBuiltin).toHaveBeenCalledExactlyOnceWith({ name, args: "first  line\nsecond" });
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/plans",
    "/nek-build id",
    "/agent",
    "/mcp status",
    "/skill:pdf",
    "@skill:pdf",
    "/my-template",
    "/plugin:model",
    "/Model",
    "/model-extra",
    "ask about /model",
    "//model",
    "/goal objective",
    "/target",
  ])("SC-2 keeps the prompt path for %s", (text) => {
    const runBuiltin = vi.fn();
    const sendText = vi.fn(() => text);
    expect(routeNekSlashSubmission(text, runBuiltin, sendText)).toBe(text);
    expect(runBuiltin).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("SC-2 keeps the existing GUI /plan shortcut and passes other extensions through", () => {
    expect(parseV4VisibleSlashCommand("/plan do this")).toMatchObject({
      kind: "planShortcut",
      task: "do this",
    });
    expect(parseV4VisibleSlashCommand("/plan do this", ["attachment"])).toMatchObject({
      kind: "unsupportedPlanShortcut",
    });
    expect(parseV4VisibleSlashCommand("/plans")).toBeNull();
  });
  it.each(["/goal", "/goal resume", "/goal new objective", "/target replace objective"])(
    "SC-5 does not parse former goal input %s as a GUI command",
    (text) => expect(parseV4VisibleSlashCommand(text)).toBeNull(),
  );
});
