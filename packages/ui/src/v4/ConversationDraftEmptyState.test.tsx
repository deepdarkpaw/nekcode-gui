// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "./ConversationDraftEmptyState.js";

const GREETING = "[data-v4-draft-greeting]";

it("ZR-9 preserves the 20–30px display greeting as the available width changes", async () => {
  let width = 320;
  vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, this.matches(GREETING) ? width : 300, 40);
    },
  );

  const { container } = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <style>{`${GREETING} { padding-left: 0px; padding-right: 0px; }`}</style>
      <ConversationDraftEmptyState />
    </ZCodeIntlProvider>,
  );
  const greeting = container.querySelector<HTMLElement>(GREETING);
  const measuredFontSize = () => greeting?.style.getPropertyValue("--v4-draft-greeting-font-size");

  expect(measuredFontSize()).toBe("30px");
  for (const [available, expected] of [
    [240, "24px"],
    [150, "20px"],
    [320, "30px"],
  ] as const) {
    width = available;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(measuredFontSize()).toBe(expected));
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
