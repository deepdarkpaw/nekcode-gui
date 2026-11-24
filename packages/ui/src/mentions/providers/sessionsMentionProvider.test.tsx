// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useSessionsMentionProvider } from "./sessionsMentionProvider.js";

const workspacePath = "/fixtures/project";
const services = { zcodeAgentService: {} } as unknown as IServiceAccessor;
const tasks: ZCodeTaskMeta[] = [
  {
    taskId: "sess_unnamed",
    traceId: "trace-a",
    title: "",
    workspacePath,
    mode: "agent",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    taskId: "sess_named",
    traceId: "trace-b",
    title: "会话 A",
    workspacePath,
    mode: "agent",
    createdAt: 2,
    updatedAt: 2,
  },
];

vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: tasks, hydratingEndpointKeys: [] }),
}));

afterEach(cleanup);

it.each([
  { locale: "zh-CN", unnamedLabel: "新任务" },
  { locale: "en-US", unnamedLabel: "New task" },
] as const)(
  "TT-4 localizes the unnamed task reference in $locale without rewriting titles or IDs",
  ({ locale, unnamedLabel }) => {
    const { result } = renderHook(
      () =>
        useSessionsMentionProvider(
          "glm",
          workspacePath,
          undefined,
          "",
          true,
          "current-workspace",
          "empty",
          "title",
        ),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ServiceProvider services={services}>
            <TabStoreProvider>
              <ZCodeIntlProvider initialLocale={locale}>{children}</ZCodeIntlProvider>
            </TabStoreProvider>
          </ServiceProvider>
        ),
      },
    );

    expect(result.current.items).toMatchObject([
      { value: "sess_named", label: "会话 A", markdown: "[#会话 A](#sess_named)" },
      {
        id: "session:sess_unnamed",
        category: "sessions",
        value: "sess_unnamed",
        label: unnamedLabel,
        markdown: `[#${unnamedLabel}](#sess_unnamed)`,
      },
    ]);
  },
);
