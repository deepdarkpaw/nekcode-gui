// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";

const timeline = vi.hoisted(() => vi.fn());
vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/v4/ConversationTimeline.js", () => ({
  ConversationTimeline: (props: unknown) => {
    timeline(props);
    return <div data-testid="standard-timeline" />;
  },
}));
const tab: SubagentSessionSidePaneTab = {
  id: "side-tab",
  type: "subagent-session",
  workspaceKey: "remote",
  workspacePath: "/remote/project",
  workspaceIdentity: "remote-workspace",
  remoteSessionId: "ssh-host",
  rootSessionId: "root",
  parentSessionId: "parent",
  childSessionId: "child",
  subagentType: "worker",
  title: "Inspect source",
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("S1/S2: the right-side tab uses parent-scoped preview and the standard read-only timeline", async () => {
  const getSubagentConversation = vi
    .fn()
    .mockRejectedValueOnce(new Error("preview unavailable"))
    .mockResolvedValue({
      status: "completed",
      rows: [],
      totalCount: 0,
    });
  const subscribeConversationV4 = vi.fn();
  const services = {
    zcodeAgentService: { getSubagentConversation, subscribeConversationV4 },
  } as unknown as IServiceAccessor;
  render(
    <ServiceProvider services={services}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <SubagentSessionSidePane tab={tab} focused onOpenSubagentSession={vi.fn()} />
      </ZCodeIntlProvider>
    </ServiceProvider>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("preview unavailable");
  fireEvent.click(screen.getByRole("button", { name: "加载失败，重试" }));
  await screen.findByTestId("standard-timeline");
  await waitFor(() => expect(getSubagentConversation).toHaveBeenCalledTimes(2));
  expect(getSubagentConversation).toHaveBeenLastCalledWith({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: "parent",
    id: "child",
  });
  expect(subscribeConversationV4).not.toHaveBeenCalled();
  const props = timeline.mock.calls.at(-1)![0];
  expect(props.rowContext.sessionId).toBe("child");
  expect(props.rowContext.workspaceRemoteSessionId).toBe("ssh-host");
  expect(props.onFork).toBeUndefined();
  expect(props.onEdit).toBeUndefined();
});
