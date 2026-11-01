// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionSubscriptionErrorPanel } from "./SessionSubscriptionErrorPanel.js";

function renderPanel(detail: string | null, onReconnect = vi.fn()) {
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <SessionSubscriptionErrorPanel detail={detail} onReconnect={onReconnect} />
    </ZCodeIntlProvider>,
  );
  return onReconnect;
}

describe("SessionSubscriptionErrorPanel", () => {
  afterEach(cleanup);

  it("leads with a localized title and keeps the fault code as secondary detail", () => {
    const onReconnect = renderPanel("fault.subscription.recoveryFrameTimedOut");
    const alert = screen.getByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe("无法加载此会话");
    expect(screen.getByText("fault.subscription.recoveryFrameTimedOut").className).toContain(
      "text-muted-foreground",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("omits the detail line when the store has no error text", () => {
    renderPanel(null);
    expect(screen.getByRole("alert").querySelectorAll("p")).toHaveLength(1);
  });
});
