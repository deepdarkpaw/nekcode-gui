/**
 * 设置中心页面外框：
 * - 涉及 nek 配置的页面顶部显示"配置目标"切换，页头始终写明当前目标主机；
 * - 使用 mock 数据时显式标注；
 * - 文档的外部修改 / 冲突横幅集中显示在页首。
 */
import type { ReactNode } from "react";
import type { NekConfigRevision } from "@zcode/shared/nek-protocol";
import { FlaskConicalIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekSettingsContext } from "../api/NekSettingsContext.js";
import { useNekReloadNotifications } from "../api/useNekReloadNotifications.js";
import type { NekDocument } from "../api/useNekDocument.js";
import { DocumentBanners } from "./DocumentStatus.js";
import { TargetSwitcher } from "./TargetSwitcher.js";

export function NekPageFrame({
  usesTarget,
  description,
  documents = [],
  actions,
  children,
  showMockBadge = usesTarget,
}: {
  usesTarget: boolean;
  /** 页面数据来自 mock 时显示“模拟数据”标记；默认与 usesTarget 一致。 */
  showMockBadge?: boolean;
  description?: ReactNode;
  documents?: ReadonlyArray<
    Pick<NekDocument<NekConfigRevision>, "banner" | "resolveBanner"> | undefined
  >;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const { isMock, targetInfo } = useNekSettingsContext();
  // 写盘后的自动 reload 失败：所有页面都要提示（进程级失败与页面无关）。
  useNekReloadNotifications();
  return (
    <div data-slot="nek-settings-page" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {description ? <p className="text-ui-sm text-foreground-subtle">{description}</p> : null}
          {usesTarget && targetInfo ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.nek.target.editing" },
                { host: targetInfo.label },
              )}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isMock && showMockBadge ? (
            <span
              title={intl.formatMessage({ id: "settings.nek.mockBadgeHint" })}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-warning/40 px-2 text-ui-xs font-medium text-warning"
            >
              <FlaskConicalIcon className="size-3" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.nek.mockBadge" })}
            </span>
          ) : null}
          {actions}
          {usesTarget ? <TargetSwitcher /> : null}
        </div>
      </div>
      <DocumentBanners documents={documents} />
      {children}
    </div>
  );
}
