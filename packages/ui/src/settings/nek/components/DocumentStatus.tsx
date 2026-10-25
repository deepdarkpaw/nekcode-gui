/**
 * 文档状态展示：外部修改 / 冲突横幅，加载中、加载失败、目标未连接的占位。
 */
import type { ReactNode } from "react";
import { AlertTriangleIcon, LoaderIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react";
import type { NekConfigDiagnostic, NekConfigRevision } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekHostApi, useNekTarget } from "../api/NekSettingsContext.js";
import type { NekDocument } from "../api/useNekDocument.js";

type AnyDocument = Pick<NekDocument<NekConfigRevision>, "banner" | "resolveBanner">;
type GateDocument = Pick<NekDocument<NekConfigRevision>, "status" | "error" | "reload">;

/** "配置已在外部修改 [重新载入] [保留我的修改]"。 */
export function DocumentBanners({
  documents,
}: {
  documents: ReadonlyArray<AnyDocument | undefined>;
}) {
  const { intl } = useZCodeIntl();
  const active = documents.filter((doc): doc is AnyDocument => Boolean(doc?.banner));
  if (active.length === 0) {
    return null;
  }
  const conflict = active.some((doc) => doc.banner?.kind === "conflict");
  const resolveAll = (choice: "reload" | "keep") =>
    Promise.all(active.map((doc) => doc.resolveBanner(choice)));
  return (
    <div
      role="alert"
      data-slot="nek-document-banner"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <AlertTriangleIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.nek.banner.externalTitle" })}
        </span>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: conflict
              ? "settings.nek.banner.conflictDescription"
              : "settings.nek.banner.externalDescription",
          })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <AsyncButton
          variant="outline"
          size="sm"
          successFeedback="none"
          onClick={() => resolveAll("reload")}
        >
          {intl.formatMessage({ id: "settings.nek.banner.reload" })}
        </AsyncButton>
        <AsyncButton
          variant="secondary"
          size="sm"
          successFeedback="none"
          onClick={() => resolveAll("keep")}
        >
          {intl.formatMessage({ id: "settings.nek.banner.keepMine" })}
        </AsyncButton>
      </div>
    </div>
  );
}

export function DiagnosticsList({
  diagnostics,
}: {
  diagnostics: readonly NekConfigDiagnostic[] | undefined;
}) {
  if (!diagnostics || diagnostics.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3">
      {diagnostics.map((item) => (
        <li key={`${item.file}:${item.message}`} className="flex items-start gap-2 text-ui-sm">
          <AlertTriangleIcon
            aria-hidden="true"
            className={
              item.severity === "error" ? "size-3.5 text-destructive" : "size-3.5 text-warning"
            }
          />
          <span className="min-w-0 flex-1 text-foreground">
            {item.message}
            <span className="ml-2 font-mono text-foreground-subtlest">{item.file}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 目标未连接：灰色说明 + "连接"入口。 */
export function DisconnectedState() {
  const { intl } = useZCodeIntl();
  const host = useNekHostApi();
  const { targetInfo, target, refreshTargets } = useNekTarget();
  return (
    <NekEmptyState
      icon={<PlugZapIcon className="size-5" aria-hidden="true" />}
      title={intl.formatMessage(
        { id: "settings.nek.target.disconnectedTitle" },
        { host: targetInfo?.label ?? "" },
      )}
      description={intl.formatMessage({ id: "settings.nek.target.disconnectedDescription" })}
      action={
        target.kind === "remote" ? (
          <AsyncButton
            onClick={async () => {
              await host.connectHost(target.connectionId);
              await refreshTargets();
            }}
          >
            {intl.formatMessage({ id: "settings.nek.target.connect" })}
          </AsyncButton>
        ) : null
      }
    />
  );
}

export function NekEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      {icon ? <div className="text-foreground-subtlest">{icon}</div> : null}
      <p className="text-ui-base font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-md text-ui-sm text-foreground-subtle">{description}</p>
      ) : null}
      {action ? <div className="mt-2 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * 文档门：未连接 / 加载中 / 失败时显示占位，就绪后渲染内容。
 * 失败时给出原因与"重试"。
 */
export function DocumentGate({
  documents,
  children,
}: {
  documents: ReadonlyArray<GateDocument>;
  children: () => ReactNode;
}) {
  const { intl } = useZCodeIntl();
  if (documents.some((doc) => doc.status === "disconnected")) {
    return <DisconnectedState />;
  }
  const failed = documents.find((doc) => doc.status === "error");
  if (failed) {
    return (
      <NekEmptyState
        icon={<AlertTriangleIcon className="size-5 text-destructive" aria-hidden="true" />}
        title={intl.formatMessage({ id: "settings.nek.load.failed" })}
        description={failed.error?.message}
        action={
          <Button
            variant="outline"
            onClick={() => void Promise.all(documents.map((doc) => doc.reload()))}
          >
            <RefreshCwIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.load.retry" })}
          </Button>
        }
      />
    );
  }
  if (documents.some((doc) => doc.status === "loading")) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 py-10 text-ui-base text-foreground-subtle"
      >
        <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.nek.load.loading" })}
      </div>
    );
  }
  return <>{children()}</>;
}
