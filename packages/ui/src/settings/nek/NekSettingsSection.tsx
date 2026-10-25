/**
 * 设置中心分区入口：注入 API（真实实现或显式标注的 mock），按分区 id 渲染页面。
 * 由 SettingsPage 在 nek 分区下渲染；配置目标状态是模块级的，切换分区时保持。
 */
import { useMemo, type ReactNode } from "react";
import { NekSettingsProvider } from "./api/NekSettingsContext.js";
import { resolveNekSettingsApis } from "./api/registry.js";
import type { NekSettingsSectionId } from "./sections.js";
import { AccountsPage } from "./pages/accounts/AccountsPage.js";
import { ProvidersPage } from "./pages/providers/ProvidersPage.js";
import { CompactionPage } from "./pages/CompactionPage.js";
import { DefaultModelPage } from "./pages/DefaultModelPage.js";

const PAGES: Partial<Record<NekSettingsSectionId, () => ReactNode>> = {
  nekAccounts: () => <AccountsPage />,
  nekProviders: () => <ProvidersPage />,
  nekCompaction: () => <CompactionPage />,
  nekDefaultModel: () => <DefaultModelPage />,
};

export function NekSettingsSection({
  sectionId,
  projectCwd,
}: {
  sectionId: NekSettingsSectionId;
  projectCwd?: string | null;
}) {
  const apis = useMemo(() => resolveNekSettingsApis(), []);
  const render = PAGES[sectionId];
  return (
    <NekSettingsProvider apis={apis} projectCwd={projectCwd ?? undefined}>
      {render ? render() : null}
    </NekSettingsProvider>
  );
}
