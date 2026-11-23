// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { addPendingSettingsSectionListener } from "@/lib/settingsNavigation.js";
import { TabStoreProvider, useTabStore } from "@/store/TabStoreProvider.js";
import { NekProjectTrustBanner } from "./NekProjectTrustBanner.js";

afterEach(cleanup);

function SettingsTabProbe() {
  const active = useTabStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  return <span data-testid="active-tab">{active?.kind}</span>;
}

it("PT-5 only shows the non-blocking notice for an untrusted runtime and opens Project settings", () => {
  const intent = vi.fn();
  const detach = addPendingSettingsSectionListener(intent);
  const fixture = (projectTrusted?: boolean) => (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TabStoreProvider>
        <SettingsTabProbe />
        <NekProjectTrustBanner projectTrusted={projectTrusted} />
      </TabStoreProvider>
    </ZCodeIntlProvider>
  );
  try {
    const view = render(fixture());
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(fixture(true));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(fixture(false));
    expect(screen.getByRole("status").textContent).toContain("项目未信任：未加载项目配置");
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    expect(intent).toHaveBeenCalledWith("nekProject");
    expect(screen.getByTestId("active-tab").textContent).toBe("settings");
    expect(screen.getByRole("status")).toBeDefined();
  } finally {
    detach();
  }
});
