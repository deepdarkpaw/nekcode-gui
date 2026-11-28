// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MessageResponse } from "./message.js";

afterEach(cleanup);

function message(text: string, streaming = false) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <MessageResponse streaming={streaming}>{text}</MessageResponse>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

it.each([false, true])("renders TeX in prose and table cells (streaming=%s)", (streaming) => {
  const { container } = render(
    message(
      String.raw`增益 \(g_0\approx \ln(G_0)/L\)，长度 $L$。

| 量 | 含义 |
| --- | --- |
| \(E_{\rm in}\) | 输入能量 |`,
      streaming,
    ),
  );
  expect(container.querySelectorAll("p .katex")).toHaveLength(2);
  expect(container.querySelector("td .katex annotation")?.textContent).toBe(String.raw`E_{\rm in}`);
});

it("does not interpret plain parentheses, code or escaped delimiters as math", () => {
  const { container } = render(
    message(
      [String.raw`(L) 与 \\(x\\)，价格 $5 到 $10。`, "`\\(y\\)`", "```text\n\\(z\\)\n```"].join(
        "\n\n",
      ),
    ),
  );
  expect(container.querySelector(".katex")).toBeNull();
  expect(container.textContent).toContain(String.raw`\(y\)`);
});

it("waits for a closing delimiter while streaming", () => {
  const ui = render(message(String.raw`能量 \(E_0`, true));
  expect(ui.container.querySelector(".katex")).toBeNull();
  ui.rerender(message(String.raw`能量 \(E_0\)`, true));
  expect(ui.container.querySelector(".katex annotation")?.textContent).toBe("E_0");
});
