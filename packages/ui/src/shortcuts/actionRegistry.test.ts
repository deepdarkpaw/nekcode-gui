import { describe, expect, it } from "vitest";
import { resolveEffectiveShortcutBindings, type ShortcutBindingEvent } from "./bindings.js";
import {
  formatActionBindingLabel,
  isSameActionBinding,
  isValidActionBinding,
  matchesActionBinding,
  parseActionBinding,
} from "./actionBinding.js";
import {
  checkActionBindingConflict,
  findActionConflicts,
  findLegacyCommandConflicts,
  formatActionShortcut,
  fromNekKeyId,
  importNekKeybindings,
  matchActionEvent,
  resolveEffectiveActionBindings,
} from "./actionRegistry.js";
import { NEK_ACTIONS, nekActionLabelId } from "./nekActions.js";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";

const mac = { platform: "MacIntel" };
const win = { platform: "Win32" };

const event = (patch: Partial<ShortcutBindingEvent>): ShortcutBindingEvent => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
});

describe("action bindings", () => {
  it("accepts kernel bindings plus Escape / Tab / Space / Backspace", () => {
    expect(isValidActionBinding("CmdOrCtrl+k")).toBe(true);
    expect(isValidActionBinding("Escape")).toBe(true);
    expect(parseActionBinding("Shift+Tab")).toMatchObject({ shift: true, key: "Tab" });
    expect(isValidActionBinding("Meta+k")).toBe(false);
    expect(isValidActionBinding("Shift+Esc")).toBe(false);
  });

  it("matches extended keys with exact modifiers", () => {
    expect(matchesActionBinding(event({ key: "Escape" }), "Escape", win)).toBe(true);
    expect(matchesActionBinding(event({ key: "Escape", ctrlKey: true }), "Escape", win)).toBe(
      false,
    );
    expect(matchesActionBinding(event({ key: "Tab", shiftKey: true }), "Shift+Tab", win)).toBe(
      true,
    );
    expect(matchesActionBinding(event({ key: "Tab" }), "Shift+Tab", win)).toBe(false);
  });

  it("ignores IME composition and key repeat", () => {
    expect(matchesActionBinding(event({ key: "Enter", keyCode: 229 }), "Enter", win)).toBe(false);
    expect(matchesActionBinding(event({ key: "Escape", isComposing: true }), "Escape", win)).toBe(
      false,
    );
  });

  it("formats labels per platform", () => {
    expect(formatActionBindingLabel("CmdOrCtrl+ArrowUp", win)).toBe("Ctrl+↑");
    expect(formatActionBindingLabel("CmdOrCtrl+ArrowUp", mac)).toBe("⌘ ↑");
    expect(formatActionBindingLabel("Alt+Enter", win)).toBe("Alt+Enter");
    expect(formatActionBindingLabel("Alt+Enter", mac)).toBe("⌥ ↩");
    expect(formatActionBindingLabel("Shift+Tab", win)).toBe("Shift+Tab");
    expect(formatActionBindingLabel("Escape", mac)).toBe("Esc");
    expect(formatActionBindingLabel("CmdOrCtrl+,", win)).toBe("Ctrl+,");
  });

  it("treats platform-equivalent bindings as the same physical key", () => {
    expect(isSameActionBinding("Ctrl+l", "CmdOrCtrl+l", win)).toBe(true);
    expect(isSameActionBinding("Ctrl+l", "CmdOrCtrl+l", mac)).toBe(false);
    expect(isSameActionBinding("Shift+Tab", "Shift+Tab", win)).toBe(true);
    expect(isSameActionBinding("Escape", "Tab", win)).toBe(false);
  });
});

describe("nek action registry", () => {
  it("ships the default keys from interaction spec §7.7", () => {
    const effective = resolveEffectiveActionBindings();
    const labels = Object.fromEntries(
      NEK_ACTIONS.map((action) => [action.id, formatActionShortcut(action.id, effective, win)]),
    );
    expect(labels).toEqual({
      "tui.input.submit": "Enter",
      "tui.input.newLine": "Shift+Enter",
      "app.message.followUp": "Alt+Enter",
      "app.interrupt": "Esc",
      "app.message.dequeue": "Alt+↑",
      "nek.plan.toggle": "Alt+M",
      "app.thinking.cycle": "Shift+Tab",
      "app.model.select": "Ctrl+L",
      "app.tools.expand": "Ctrl+O",
      "app.thinking.toggle": "Ctrl+T",
      "tui.altScreen.search": "Ctrl+F",
      "tui.altScreen.previousPrompt": "Ctrl+↑",
      "tui.altScreen.nextPrompt": "Ctrl+↓",
      "tui.altScreen.top": "Ctrl+Home",
      "tui.altScreen.bottom": "Ctrl+End",
      "app.session.new": "Ctrl+N",
      "gui.settings.open": "Ctrl+,",
      "app.editor.external": "Ctrl+G",
      "gui.commandPalette.open": "Ctrl+K",
      "gui.interaction.focus": "Alt+I",
    });
  });

  it("has no conflicts and only valid bindings by default on every platform", () => {
    const effective = resolveEffectiveActionBindings();
    for (const action of NEK_ACTIONS) {
      expect(action.defaultBindings.every(isValidActionBinding)).toBe(true);
    }
    expect(findActionConflicts(effective, win)).toEqual([]);
    expect(findActionConflicts(effective, mac)).toEqual([]);
  });

  it("provides zh-CN and en-US names for every action", () => {
    for (const action of NEK_ACTIONS) {
      expect(zhCN[nekActionLabelId(action.id)]).toBeTruthy();
      expect(enUS[nekActionLabelId(action.id)]).toBeTruthy();
      if (action.desktopNoteId) {
        expect(zhCN[action.desktopNoteId]).toBeTruthy();
        expect(enUS[action.desktopNoteId]).toBeTruthy();
      }
    }
  });

  it("applies user overrides with the kernel semantics", () => {
    const effective = resolveEffectiveActionBindings({
      "app.tools.expand": ["CmdOrCtrl+Shift+o"],
      "app.thinking.toggle": [],
      "app.model.select": ["Bogus+x"],
      "unknown.action": ["CmdOrCtrl+q"],
    });
    expect(effective["app.tools.expand"]).toEqual(["CmdOrCtrl+Shift+o"]);
    expect(effective["app.thinking.toggle"]).toEqual([]);
    expect(formatActionShortcut("app.thinking.toggle", effective, win)).toBe("");
    expect(effective["app.model.select"]).toEqual(["CmdOrCtrl+l"]);
  });

  it("detects reserved, occupied and invalid bindings", () => {
    const effective = resolveEffectiveActionBindings();
    expect(checkActionBindingConflict("app.tools.expand", "CmdOrCtrl+c", effective, win)).toEqual({
      kind: "reserved",
      binding: "CmdOrCtrl+c",
    });
    expect(checkActionBindingConflict("app.tools.expand", "Ctrl+k", effective, win)).toEqual({
      kind: "occupied",
      binding: "Ctrl+k",
      ownerActionId: "gui.commandPalette.open",
    });
    expect(checkActionBindingConflict("app.tools.expand", "Nope", effective, win)).toEqual({
      kind: "invalid",
      binding: "Nope",
    });
    expect(
      checkActionBindingConflict("app.tools.expand", "CmdOrCtrl+Shift+e", effective, win),
    ).toBe(null);
  });

  it("isolates composer-only bindings from each other but not from global ones", () => {
    const effective = resolveEffectiveActionBindings();
    // composer 动作之间冲突
    expect(
      checkActionBindingConflict("app.message.followUp", "Enter", effective, win),
    ).toMatchObject({ kind: "occupied", ownerActionId: "tui.input.submit" });
    // composer 动作占用全局键同样冲突（全局在输入框内也生效）
    expect(
      checkActionBindingConflict("app.message.followUp", "Escape", effective, win),
    ).toMatchObject({ kind: "occupied", ownerActionId: "app.interrupt" });
  });

  it("lists conflicting groups after overrides", () => {
    const effective = resolveEffectiveActionBindings({ "app.tools.expand": ["CmdOrCtrl+k"] });
    expect(findActionConflicts(effective, win)).toEqual([
      { binding: "CmdOrCtrl+k", actionIds: ["app.tools.expand", "gui.commandPalette.open"] },
    ]);
  });

  it("matches events per scope", () => {
    const effective = resolveEffectiveActionBindings();
    expect(
      matchActionEvent(event({ key: "Enter", altKey: true }), effective, "composer", win),
    ).toBe("app.message.followUp");
    expect(matchActionEvent(event({ key: "o", ctrlKey: true }), effective, "global", win)).toBe(
      "app.tools.expand",
    );
    expect(matchActionEvent(event({ key: "o", metaKey: true }), effective, "global", mac)).toBe(
      "app.tools.expand",
    );
    expect(matchActionEvent(event({ key: "Enter" }), effective, "global", win)).toBe(null);
  });

  it("reports overlaps with the existing ZCode command table during migration", () => {
    const conflicts = findLegacyCommandConflicts(
      resolveEffectiveActionBindings(),
      resolveEffectiveShortcutBindings(undefined),
      win,
    );
    expect(conflicts).toContainEqual({
      actionId: "app.tools.expand",
      commandId: "openWorkspace",
      binding: "CmdOrCtrl+o",
    });
    expect(conflicts).toContainEqual({
      actionId: "app.thinking.toggle",
      commandId: "cycleThoughtLevel",
      binding: "CmdOrCtrl+t",
    });
    // 自身对应的旧命令不算冲突
    expect(conflicts.some((conflict) => conflict.actionId === "gui.commandPalette.open")).toBe(
      false,
    );
  });
});

describe("nek keybindings import", () => {
  it("converts nek key ids to desktop bindings", () => {
    expect(fromNekKeyId("ctrl+shift+up")).toBe("CmdOrCtrl+Shift+ArrowUp");
    expect(fromNekKeyId("alt+enter")).toBe("Alt+Enter");
    expect(fromNekKeyId("shift+tab")).toBe("Shift+Tab");
    expect(fromNekKeyId("escape")).toBe("Escape");
    expect(fromNekKeyId("ctrl+f5")).toBe("CmdOrCtrl+F5");
    expect(fromNekKeyId("super+k")).toBe(null);
  });

  it("imports only GUI actions and reports unsupported keys", () => {
    const result = importNekKeybindings({
      "app.tools.expand": "ctrl+e",
      "app.thinking.toggle": [],
      "app.model.select": ["hyper+x"],
      "app.clear": "ctrl+c",
    });
    expect(result.overrides).toEqual({
      "app.tools.expand": ["CmdOrCtrl+e"],
      "app.thinking.toggle": [],
    });
    expect(result.unsupported).toEqual([{ actionId: "app.model.select", keyId: "hyper+x" }]);
  });
});
