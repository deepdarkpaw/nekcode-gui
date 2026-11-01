// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { ConversationBackgroundWorkTrigger } from "./ConversationBackgroundWorkTrigger.js";

installDomPolyfills();
afterEach(cleanup);

function work(
  workId: string,
  kind: BackgroundWorkSummary["kind"] = "bash",
  status: BackgroundWorkSummary["status"] = "running",
): BackgroundWorkSummary {
  return { workId, kind, status, title: workId, startedAt: 1, anchorRowId: null };
}

function trigger(
  backgroundWorks: BackgroundWorkSummary[],
  onOpen?: () => void,
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <TooltipProvider>
        <ConversationBackgroundWorkTrigger backgroundWorks={backgroundWorks} onOpen={onOpen} />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

describe("composer background terminal trigger", () => {
  it.each<BackgroundWorkSummary[]>([
    [],
    [work("agent", "subagent")],
    [work("finished", "bash", "resultPending"), work("failed", "bash", "failed")],
    [work("cancelled", "bash", "cancelled"), work("agent", "subagent")],
  ])("does not render without running bash work (%j)", (...backgroundWorks) => {
    render(trigger(backgroundWorks, vi.fn()));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not render an unusable trigger without an open handler", () => {
    render(trigger([work("bash")]));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("counts only running terminals in both layouts and opens the status panel", () => {
    const onOpen = vi.fn();
    render(
      trigger(
        [
          work("bash-1"),
          work("agent", "subagent"),
          work("bash-2"),
          work("completed", "bash", "resultPending"),
          work("failed", "bash", "failed"),
          work("cancelled", "bash", "cancelled"),
        ],
        onOpen,
      ),
    );
    const button = screen.getByRole("button", { name: "Open running terminals: 2" });
    expect(button.getAttribute("data-background-bash-count")).toBe("2");
    expect(button.getAttribute("data-background-total-count")).toBe("2");
    expect(button.hasAttribute("data-background-subagent-count")).toBe(false);
    for (const layout of ["typed", "compact"]) {
      expect(
        button.querySelector(`[data-composer-background-layout="${layout}"]`)?.textContent,
      ).toBe("2");
    }
    expect(button.querySelector(".lucide-bot")).toBeNull();
    expect(button.querySelector(".lucide-square-terminal")).not.toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("removes the trigger when the final terminal stops, even with a running subagent", () => {
    const onOpen = vi.fn();
    const view = render(trigger([work("bash"), work("agent", "subagent")], onOpen, "zh-CN"));
    expect(screen.getByRole("button", { name: "打开运行中的终端：1 个" })).toBeDefined();
    view.rerender(
      trigger([work("bash", "bash", "resultPending"), work("agent", "subagent")], onOpen, "zh-CN"),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
