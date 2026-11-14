// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageResponse } from "./message.js";
import { SubagentLinkProvider, SubagentReferenceText } from "./subagent-link.js";
import { parseSubagentLink, splitSubagentText } from "@/lib/markdownSubagentLink.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const childId = "0193c72a-5c2e-7000-8000-111111111111";
afterEach(cleanup);

it("SL1/SL3: a bare subagent id retains its label rather than [blocked] without local capability", () => {
  const { container } = render(
    <MessageResponse>{`See [Inspect history](${childId}).`}</MessageResponse>,
  );
  expect(container.textContent).toContain("Inspect history");
  expect(container.textContent).not.toContain("[blocked]");
  expect(container.querySelector("button, a")).toBeNull();
  expect(container.innerHTML).not.toContain(childId);
});

it("SL2/SL4: a memoized Markdown link opens only the currently rendered parent scope", () => {
  const first = vi.fn();
  const next = vi.fn();
  const text = `[Inspect history](${childId})`;
  const ui = render(
    <SubagentLinkProvider parentSessionId="parent" rootSessionId="root" onOpen={first}>
      <MessageResponse>{text}</MessageResponse>
    </SubagentLinkProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect history" }));
  expect(first).toHaveBeenCalledWith({
    parentSessionId: "parent",
    rootSessionId: "root",
    childSessionId: childId,
    title: "Inspect history",
    subagentType: "",
  });
  ui.rerender(
    <SubagentLinkProvider parentSessionId="child-parent" rootSessionId="other-root" onOpen={next}>
      <MessageResponse>{text}</MessageResponse>
    </SubagentLinkProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect history" }));
  expect(first).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledWith(
    expect.objectContaining({ parentSessionId: "child-parent", rootSessionId: "other-root" }),
  );
  ui.rerender(
    <SubagentLinkProvider>
      <MessageResponse>{text}</MessageResponse>
    </SubagentLinkProvider>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(ui.container.textContent).toBe("Inspect history");
});

it.each([true, false])(
  "SL4: complete and streaming replies use the same internal link (%s)",
  (streaming) => {
    const open = vi.fn();
    render(
      <SubagentLinkProvider parentSessionId="parent" onOpen={open}>
        <MessageResponse streaming={streaming}>{`[Worker](${childId})`}</MessageResponse>
      </SubagentLinkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Worker" }));
    expect(open).toHaveBeenCalledTimes(1);
  },
);

it("SL5: thinking preserves literal Markdown/code but recognizes a simple reference", () => {
  const text = `**plain** \n[Worker](${childId}) \n\`[Code](${childId})\` \n\\[Escaped](${childId})`;
  const open = vi.fn();
  const ui = render(
    <SubagentLinkProvider parentSessionId="parent" onOpen={open}>
      <SubagentReferenceText text={text} />
    </SubagentLinkProvider>,
  );
  expect(ui.container.textContent).toContain("**plain**");
  expect(ui.container.textContent).toContain(`[Code](${childId})`);
  expect(ui.container.textContent).toContain(`[Escaped](${childId})`);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Worker" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: childId }));
  expect(splitSubagentText(`\`\`\`md\n[Code](${childId})\n\`\`\``)).toEqual([
    { text: `\`\`\`md\n[Code](${childId})\n\`\`\`` },
  ]);
});

it.each([
  "javascript:alert(1)",
  "data:text/html,evil",
  `../${childId}`,
  `${childId}/file`,
  `%23nek-subagent:${childId}`,
  `${childId}?path=secret`,
  "not-an-id",
])("SL7: unsafe/ambiguous destinations do not gain an internal capability (%s)", (href) => {
  expect(parseSubagentLink(href)).toBeNull();
  const open = vi.fn();
  const { container } = render(
    <SubagentLinkProvider parentSessionId="parent" onOpen={open}>
      <MessageResponse>{`[Unsafe](${href})`}</MessageResponse>
    </SubagentLinkProvider>,
  );
  expect(container.querySelector("button")).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("SL7: HTTP(S) continues through the existing external handler, not the internal opener", () => {
  const open = vi.fn();
  const external = vi.fn();
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <SubagentLinkProvider parentSessionId="parent" onOpen={open}>
          <MessageResponse onOpenExternalUrl={external}>
            {"[Docs](https://example.com/docs)"}
          </MessageResponse>
        </SubagentLinkProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
  fireEvent.click(screen.getByText("Docs"));
  expect(external).toHaveBeenCalledWith("https://example.com/docs");
  expect(open).not.toHaveBeenCalled();
});
