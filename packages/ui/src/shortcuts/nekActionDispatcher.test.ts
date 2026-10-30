import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutBindingEvent } from "./bindings.js";
import {
  dispatchNekAction,
  registerNekActionHandlers,
  resetNekActionHandlersForTest,
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

  it("K3: editable targets only admit actions explicitly allowed by the action definition", () => {
    const bindings = resolveEffectiveActionBindings();
    expect(
      resolveNekActionKeyboardEvent(event({ key: "o", ctrlKey: true }), bindings, true, win),
    ).toBe(null);
    expect(
      resolveNekActionKeyboardEvent(event({ key: "f", ctrlKey: true }), bindings, true, win),
    ).toBe("tui.altScreen.search");
  });

  it("K4: composer scope resolves Shift+Tab only while editing", () => {
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
      ),
    ).toBe("app.thinking.cycle");
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
    expect(getNekActionDisabledReason("app.model.select")).toEqual({
      id: "ui.action.unavailable.modelPicker",
    });
    expect(getNekActionDisabledReason("app.editor.external")).toEqual({
      id: "ui.action.unavailable.externalEditor",
    });
  });
});
