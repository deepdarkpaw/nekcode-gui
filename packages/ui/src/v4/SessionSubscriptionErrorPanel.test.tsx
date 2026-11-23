// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionSubscriptionErrorPanel } from "./SessionSubscriptionErrorPanel.js";

function renderPanel(detail: string | null, onReconnect = vi.fn()) {
  render(
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <SessionSubscriptionErrorPanel detail={detail} onReconnect={onReconnect} />
      </ZCodeIntlProvider>
    </TooltipProvider>,
  );
  return onReconnect;
}

describe("SessionSubscriptionErrorPanel", () => {
  afterEach(cleanup);

  it("FU1: centered connection failure uses local copy and keeps raw detail folded", async () => {
    const gate = Promise.withResolvers<void>();
    const onReconnect = renderPanel(
      "fault.subscription.recoveryFrameTimedOut",
      vi.fn(() => gate.promise),
    );
    const alert = screen.getByRole("alert", { name: "无法加载此任务" });
    expect(alert.className).toContain("justify-center");
    expect(alert.textContent).not.toContain("fault.subscription");
    fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
    expect((await screen.findByText("fault.subscription.recoveryFrameTimedOut")).tagName).toBe(
      "PRE",
    );
    const reconnect = screen.getByRole("button", { name: "重新连接" });
    fireEvent.click(reconnect);
    await waitFor(() => expect(reconnect.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(reconnect);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(reconnect.getAttribute("aria-busy")).toBeNull());
  });

  it("omits the detail line when the store has no error text", () => {
    renderPanel(null);
    expect(screen.getByRole("alert").querySelectorAll("p")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).not.toContain("无法加载此任务");
    expect(screen.getByRole("alert").textContent).toContain("连接");
  });
});
