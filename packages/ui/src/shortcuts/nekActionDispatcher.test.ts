import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutBindingEvent } from "./bindings.js";
import {
  dispatchNekAction,
  registerNekActionHandlers,
  resetNekActionHandlersForTest,
  resolveNekActionDispatchPhase,
  resolveNekActionKeyboardEvent,
} from "./nekActionDispatcher.js";
import { resolveEffectiveActionBindings, getNekActionDisabledReason } from "./actionRegistry.js";

const win = { platform: "Win32" };
const event = (patch: Partial<ShortcutBindingEvent>): ShortcutBindingEvent => ({
  key: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
});

describe("nek action dispatch", () => {
  afterEach(() => resetNekActionHandlersForTest());

  it("K1: resolves the registered Ctrl+O action and allows it outside editing", () => {
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "o", ctrlKey: true }),
        resolveEffectiveActionBindings(),
        false,
        win,
      ),
    ).toBe("app.tools.expand");
  });

  it("K2: IME composition and repeat never resolve an action", () => {
    const bindings = resolveEffectiveActionBindings();
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "o", ctrlKey: true, isComposing: true }),
        bindings,
      ),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(event({ key: "o", ctrlKey: true, keyCode: 229 }), bindings),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(event({ key: "o", ctrlKey: true, repeat: true }), bindings),
    ).toBe(null);
  });

  it("K3: editable targets keep registered actions but never swallow a typed capital letter", () => {
    const bindings = resolveEffectiveActionBindings();
    // 显示类动作（折叠 / 搜索 / 转写区跳转）在输入框里照样生效。
    expect(
      resolveNekActionKeyboardEvent(event({ key: "o", ctrlKey: true }), bindings, true, win),
    ).toBe("app.tools.expand");
    expect(
      resolveNekActionKeyboardEvent(event({ key: "f", ctrlKey: true }), bindings, true, win),
    ).toBe("tui.altScreen.search");
    // 用户把动作改绑成 Shift+字母后，输入框里必须让路给大写字面输入。
    const rebindable = resolveEffectiveActionBindings({ "app.model.select": ["Shift+g"] });
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "G", code: "KeyG", shiftKey: true }),
        rebindable,
        true,
        win,
      ),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "G", code: "KeyG", shiftKey: true }),
        rebindable,
        false,
        win,
      ),
    ).toBe("app.model.select");
  });

  it("K4: composer scope resolves Shift+Tab only while editing and only in the bubble phase", () => {
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "Tab", shiftKey: true }),
        resolveEffectiveActionBindings(),
        false,
        win,
      ),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "Tab", shiftKey: true }),
        resolveEffectiveActionBindings(),
        true,
        win,
        "bubble",
      ),
    ).toBe("app.thinking.cycle");
    expect(
      resolveNekActionKeyboardEvent(
        event({ key: "Tab", shiftKey: true }),
        resolveEffectiveActionBindings(),
        true,
        win,
        "capture",
      ),
    ).toBe(null);
  });

  it("K5: dispatch runs the focused handler and does not run it twice after cleanup", () => {
    const run = vi.fn();
    const dispose = registerNekActionHandlers({ "app.tools.expand": { run } }, 10);
    expect(dispatchNekAction("app.tools.expand")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    dispose();
    expect(dispatchNekAction("app.tools.expand")).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("K6: disabled runtime handlers are not reported as handled", () => {
    const run = vi.fn();
    registerNekActionHandlers({
      "app.thinking.toggle": {
        enabled: false,
        disabledReason: { id: "ui.action.busy" },
        run,
      },
    });
    expect(dispatchNekAction("app.thinking.toggle")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("K7: registry marks unavailable targets with a reason instead of claiming success", () => {
    expect(getNekActionDisabledReason("app.editor.external")).toEqual({
      id: "ui.action.unavailable.externalEditor",
    });
    expect(getNekActionDisabledReason("gui.interaction.focus")).toEqual({
      id: "ui.action.unavailable.interactionFocus",
    });
  });

  it("K8: a handler that reports no target is not handled, so the key stays untouched", () => {
    const run = vi.fn(() => false);
    registerNekActionHandlers({ "tui.altScreen.previousPrompt": { run } });
    expect(dispatchNekAction("tui.altScreen.previousPrompt")).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("K9: Esc defers to inner handlers while other global actions stay in the capture phase", () => {
    expect(resolveNekActionDispatchPhase("app.interrupt")).toBe("bubble");
    expect(resolveNekActionDispatchPhase("app.tools.expand")).toBe("capture");
    expect(resolveNekActionDispatchPhase("app.thinking.cycle")).toBe("bubble");
    const bindings = resolveEffectiveActionBindings();
    expect(
      resolveNekActionKeyboardEvent(event({ key: "Escape" }), bindings, true, win, "capture"),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(event({ key: "Escape" }), bindings, true, win, "bubble"),
    ).toBe("app.interrupt");
  });

  it("K10: the handler receives the originating keyboard event", () => {
    const run = vi.fn(() => true);
    registerNekActionHandlers({ "app.interrupt": { run } });
    const keyboardEvent = {} as KeyboardEvent;
    expect(dispatchNekAction("app.interrupt", keyboardEvent)).toBe(true);
    expect(run).toHaveBeenCalledWith({ event: keyboardEvent });
  });
});
