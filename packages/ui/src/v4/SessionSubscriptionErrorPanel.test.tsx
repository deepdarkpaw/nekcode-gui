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

  it("GU-1: matches the upstream centered connection error and reconnect action", () => {
    const onReconnect = renderPanel("Connection lost");
    const alert = screen.getByRole("alert");
    expect(alert.firstElementChild?.textContent).toBe("Connection lost");
    expect(screen.getByText("Connection lost").className).toContain("font-mono");
    expect(screen.getByText("Connection lost").className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("omits the detail line when the store has no error text", () => {
    renderPanel(null);
    expect(screen.getByRole("alert").querySelectorAll("p")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).not.toContain("无法加载此会话");
    expect(screen.getByRole("alert").textContent).toContain("连接");
  });
});
