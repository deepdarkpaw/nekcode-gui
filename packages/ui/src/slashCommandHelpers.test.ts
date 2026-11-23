import { expect, it, vi } from "vitest";
import { buildSlashCommandSuggestions } from "./slashCommandHelpers.js";
import enUS from "./i18n/locales/en-US.js";
import zhCN from "./i18n/locales/zh-CN.js";

it("SC-4 lists only actionable, localized built-ins alongside the RPC catalog", () => {
  const suggestions = buildSlashCommandSuggestions(
    [
      { name: "model", description: "shadowed extension" },
      { name: "/tree", description: "also shadowed, even without a GUI action" },
      { name: "local:model", description: "qualified extension invocation" },
      { name: "Model", description: "case-distinct extension invocation" },
      { name: "side", description: "side extension" },
      { name: "review", description: "prompt template" },
    ],
    [
      { value: "side", description: "shadowed app command", run: vi.fn() },
      { value: "btw", description: "app command", run: vi.fn() },
    ],
    (name) => {
      const id = `chat.slash.builtin.${name}`;
      expect(enUS[id]).toBeTruthy();
      return zhCN[id]!;
    },
  );
  expect(suggestions.map((item) => item.value)).toEqual([
    "settings",
    "model",
    "thinking",
    "scoped-models",
    "export",
    "import",
    "copy",
    "name",
    "session",
    "hotkeys",
    "fork",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
    "local:model",
    "Model",
    "side",
    "review",
    "btw",
  ]);
  expect(suggestions.find((item) => item.value === "model")?.description).toBe("选择或切换模型");
  expect(suggestions.find((item) => item.value === "side")?.description).toBe("side extension");
});
