// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";

installDomPolyfills();

function renderTooltip(open: boolean | undefined) {
  return (
    <TooltipProvider>
      <ControlHintTooltip title="Model" open={open}>
        <button type="button">trigger</button>
      </ControlHintTooltip>
    </TooltipProvider>
  );
}

describe("ControlHintTooltip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the Radix root controlled while the override toggles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rendered = render(renderTooltip(undefined));
    expect(screen.queryByRole("tooltip")).toBeNull();

    rendered.rerender(renderTooltip(true));
    expect(screen.getAllByText("Model").length).toBeGreaterThan(0);

    rendered.rerender(renderTooltip(undefined));
    rendered.rerender(renderTooltip(false));
    const messages = [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));
    expect(messages.filter((message) => /controlled/u.test(message))).toEqual([]);
  });
});
