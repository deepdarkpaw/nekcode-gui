// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NekOnboardingModal } from "./NekOnboardingModal.js";
import {
  createNekTestEnv,
  flushNek,
  installDomPolyfills,
} from "@/settings/nek/test/nekTestUtils.js";

installDomPolyfills();

describe("NekOnboardingModal", () => {
  it("renders controller data for the nek step", async () => {
    const env = createNekTestEnv();
    const wrapper = ({ children }: { children: ReactNode }) => env.wrapper({ children });
    render(
      <NekOnboardingModal
        open
        onComplete={vi.fn()}
        onClose={vi.fn()}
        onOpenLogin={vi.fn()}
        onOpenProviderForm={vi.fn()}
        onOpenRemote={vi.fn()}
      />,
      { wrapper },
    );

    await flushNek();
    expect(await screen.findByText("已安装 nek 0.4.0")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "引导步骤" })).toBeTruthy();
    expect(screen.getByText("高级")).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "引导步骤" });
    expect(within(navigation).getByText("账号与服务商")).toBeTruthy();
    expect(within(navigation).getByText("工作区")).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: /账号与服务商/ })).toBeNull();
    expect(navigation.querySelector('[aria-current="step"]')?.textContent).toContain("nek");

    const next = screen.getByRole("button", { name: "下一步" });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(next.getAttribute("data-state")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(next);
    await flushNek();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "下一步" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await flushNek();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "选择本机文件夹" })),
    );
  });
});
