// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
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
  });
});
