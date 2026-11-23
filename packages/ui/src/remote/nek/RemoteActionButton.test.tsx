// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { setActionShortcutOverrides } from "@/shortcuts/useActionShortcuts.js";
import { RemoteActionButton, RemoteActionError } from "./RemoteActionButton.js";
import type { RemoteActionHandle } from "./remoteInteraction.js";

const action: RemoteActionHandle = {
  label: { id: "Acknowledge" },
  visible: true,
  enabled: true,
  pending: false,
  run: async () => {},
};
const intl = { formatMessage: ({ id }: { id: string }) => id };

function renderAction(overrides: Partial<RemoteActionHandle> = {}) {
  const current = { ...action, ...overrides };
  render(
    <TooltipProvider>
      <RemoteActionButton action={current} intl={intl} />
      <RemoteActionError action={current} />
    </TooltipProvider>,
  );
  return screen.getByRole("button", { name: "Acknowledge" });
}

it("ZR-6 an ordinary remote button does not repeat its name on focus", () => {
  const button = renderAction({ error: "The action failed" });
  act(() => button.focus());

  expect(document.activeElement).toBe(button);
  expect(button.hasAttribute("data-state")).toBe(false);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("The action failed");
});

it("ZR-6 keyboard focus can still reveal the disabled reason", async () => {
  const button = renderAction({ enabled: false, disabledReason: { id: "Connection in progress" } });
  const trigger = button.closest<HTMLElement>('[data-slot="disabled-reason-trigger"]');
  act(() => trigger?.focus());

  expect(document.activeElement).toBe(trigger);
  expect((await screen.findByRole("tooltip")).textContent).toContain("Connection in progress");
});

it("ZR-6 shows the effective shortcut rather than a name-only hint", async () => {
  const shortcutActionId = "gui.settings.open";
  setActionShortcutOverrides({ [shortcutActionId]: ["Alt+q"] });
  const button = renderAction({ shortcutActionId });
  act(() => button.focus());

  expect((await screen.findByRole("tooltip")).textContent).toContain("Q");
  expect(document.body.querySelector('kbd[data-slot="kbd"]')?.textContent).toContain("Q");
});

afterEach(() => {
  cleanup();
  setActionShortcutOverrides({});
});
