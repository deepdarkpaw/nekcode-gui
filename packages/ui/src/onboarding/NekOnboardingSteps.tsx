import type { ReactNode } from "react";
import { LoaderIcon } from "lucide-react";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OnboardingStep } from "./onboardingFlow.js";
import type { OnboardingController } from "./useNekOnboardingController.js";
import type { OnboardingActionHandle } from "./onboardingAction.js";

export function formatOnboardingMessage(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  id: string,
  values?: Record<string, string | number>,
): string {
  return intl.formatMessage({ id }, values);
}

export function OnboardingActionButton({
  action,
  label,
  intl,
  variant,
  children,
  onClick,
  ref,
}: {
  action: OnboardingActionHandle;
  label: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  variant?: "default" | "outline" | "ghost" | "destructive";
  children?: ReactNode;
  onClick?: () => void;
  ref?: (element: HTMLElement | null) => void;
}) {
  if (!action.visible) return null;
  const reason = action.disabledReason
    ? formatOnboardingMessage(intl, action.disabledReason.id, action.disabledReason.values)
    : undefined;
  const button = (
    <Button
      ref={ref}
      type="button"
      variant={
        action.destructive ? "destructive" : (variant ?? (action.primary ? "default" : "outline"))
      }
      disabled={!action.enabled}
      aria-busy={action.pending || undefined}
      aria-invalid={action.error ? true : undefined}
      onClick={onClick ?? (() => void action.run())}
    >
      {action.pending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
      {children ?? label}
    </Button>
  );
  return (
    <ActionTooltip
      label={label}
      disabled={!action.enabled}
      disabledReason={reason}
      description={action.error}
    >
      {button}
    </ActionTooltip>
  );
}

export function OnboardingActionError({ action }: { action: OnboardingActionHandle }) {
  return action.error ? (
    <p role="alert" className="text-ui-sm text-destructive">
      {action.error}
    </p>
  ) : null;
}

function NekStep({ controller }: { controller: OnboardingController }) {
  const { intl } = useZCodeIntl();
  const { nek } = controller.view;
  const statusId =
    nek.status === "ready"
      ? "onboarding.nek.ready"
      : nek.status === "not_installed"
        ? "onboarding.nek.notInstalled"
        : nek.status === "incompatible"
          ? "onboarding.nek.incompatible"
          : nek.status === "failed"
            ? "onboarding.nek.failed"
            : nek.status === "install_failed"
              ? "onboarding.nek.installFailed"
              : nek.status === "install_cancelled"
                ? "onboarding.nek.installCancelled"
                : "onboarding.nek.checking";
  let statusValues: Record<string, string | number> | undefined;
  if (nek.status === "ready" || nek.status === "incompatible") {
    statusValues = {
      version: nek.detection && "version" in nek.detection ? nek.detection.version : "",
    };
  } else if (nek.status === "install_failed") {
    statusValues = { message: nek.message ?? "" };
  }
  return (
    <section className="flex min-h-56 flex-col gap-4" aria-labelledby="nek-onboarding-nek">
      <div>
        <h3 id="nek-onboarding-nek" className="text-ui-base font-medium">
          {formatOnboardingMessage(intl, statusId, statusValues)}
        </h3>
        {nek.detection && "path" in nek.detection ? (
          <p className="mt-1 break-all font-mono text-ui-sm text-foreground-subtle">
            {nek.detection.path}
          </p>
        ) : null}
        {nek.detection?.status === "incompatible" ? (
          <p className="mt-1 text-ui-sm text-warning">
            {nek.detection.protocolVersion} / {nek.detection.requiredProtocolVersion}
          </p>
        ) : null}
        {nek.message && nek.status === "failed" ? (
          <p className="mt-1 text-ui-sm text-destructive">{nek.message}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OnboardingActionButton
          action={controller.actions.install}
          label={formatOnboardingMessage(intl, "onboarding.nek.install")}
          intl={intl}
          ref={controller.focus.ref("install")}
        />
        <OnboardingActionButton
          action={controller.actions.update}
          label={formatOnboardingMessage(intl, "onboarding.nek.update")}
          intl={intl}
          ref={controller.focus.ref("update")}
        />
        <OnboardingActionButton
          action={controller.actions.cancelInstall}
          label={formatOnboardingMessage(intl, "onboarding.nek.cancelInstall")}
          intl={intl}
          variant="ghost"
          ref={controller.focus.ref("recheck")}
        />
        <OnboardingActionButton
          action={controller.actions.recheck}
          label={formatOnboardingMessage(intl, "onboarding.nek.recheck")}
          intl={intl}
          variant="ghost"
          ref={controller.focus.ref("recheck")}
        />
        <OnboardingActionButton
          action={controller.actions.copyCommand}
          label={formatOnboardingMessage(intl, "onboarding.nek.copyCommand")}
          intl={intl}
          ref={controller.focus.ref("recheck")}
        />
      </div>
      <details
        className="rounded-xl border border-card-border bg-card p-3"
        open={nek.channel === "dev"}
      >
        <summary className="cursor-pointer text-ui-sm font-medium">高级</summary>
        <div className="mt-3 flex items-center gap-2 text-ui-sm">
          {(["stable", "dev"] as const).map((channel) => (
            <label key={channel} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="nek-channel"
                value={channel}
                checked={nek.channel === channel}
                disabled={nek.status === "installing"}
                onChange={() => controller.actions.setChannel(channel)}
              />
              {channel}
            </label>
          ))}
        </div>
      </details>
      {nek.log.length > 0 ? (
        <pre
          aria-label="nek 安装日志"
          className="max-h-40 overflow-y-auto rounded-xl bg-surface p-3 font-mono text-ui-sm"
        >
          {nek.log.join("\n")}
          {nek.logTruncated ? "\n…" : ""}
        </pre>
      ) : null}
      <OnboardingActionError action={controller.actions.install} />
      <OnboardingActionError action={controller.actions.update} />
      <OnboardingActionError action={controller.actions.copyCommand} />
    </section>
  );
}

function AccountStep({ controller }: { controller: OnboardingController }) {
  const { intl } = useZCodeIntl();
  const account = controller.view.account;
  return (
    <section className="flex min-h-56 flex-col gap-4" aria-labelledby="nek-onboarding-account">
      <div className="flex flex-col gap-2">
        {account.logins.map((login) => {
          const titleId =
            login.provider === "anthropic"
              ? "settings.nek.accounts.claude.title"
              : "settings.nek.accounts.codex.title";
          const action =
            login.provider === "anthropic"
              ? controller.actions.loginAnthropic
              : controller.actions.loginCodex;
          const labelId =
            login.state === "ok"
              ? "onboarding.account.relogin"
              : login.provider === "anthropic"
                ? "onboarding.account.loginAnthropic"
                : "onboarding.account.loginCodex";
          return (
            <div
              key={login.provider}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-card-border bg-card p-3"
            >
              <div>
                <h3 className="text-ui-base font-medium">
                  {formatOnboardingMessage(intl, titleId)}
                </h3>
                <p className="text-ui-sm text-foreground-subtle">
                  {formatOnboardingMessage(intl, login.message.id)}
                </p>
              </div>
              <OnboardingActionButton
                action={action}
                label={formatOnboardingMessage(intl, labelId)}
                intl={intl}
                ref={
                  login.provider === "anthropic"
                    ? controller.focus.ref("loginAnthropic")
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OnboardingActionButton
          action={controller.actions.addProvider}
          label={formatOnboardingMessage(intl, "onboarding.account.addProvider")}
          intl={intl}
          ref={controller.focus.ref("loginAnthropic")}
        />
        <OnboardingActionButton
          action={controller.actions.refreshAccount}
          label={formatOnboardingMessage(intl, "onboarding.nek.recheck")}
          intl={intl}
          variant="ghost"
          ref={controller.focus.ref("loginAnthropic")}
        />
      </div>
      {account.providers.length > 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-3">
          <p className="text-ui-sm font-medium">已配置服务商</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-ui-sm text-foreground-subtle">
            {account.providers.map((provider) => (
              <li key={provider} className="font-mono">
                {provider}
              </li>
            ))}
            {account.moreProviders > 0 ? (
              <li>
                {formatOnboardingMessage(intl, "onboarding.account.providersMore", {
                  count: account.moreProviders,
                })}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {account.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {account.error}
        </p>
      ) : null}
    </section>
  );
}

function WorkspaceStep({ controller }: { controller: OnboardingController }) {
  const { intl } = useZCodeIntl();
  const selection = controller.view.workspace.selection;
  const selectionLabel = selection
    ? selection.kind === "local"
      ? selection.path
      : `${selection.label}:${selection.path}`
    : "—";
  return (
    <section className="flex min-h-56 flex-col gap-4" aria-labelledby="nek-onboarding-workspace">
      <div className="rounded-xl border border-card-border bg-card p-4">
        <h3 id="nek-onboarding-workspace" className="text-ui-base font-medium">
          已选工作区
        </h3>
        <p className="mt-2 break-all font-mono text-ui-sm text-foreground-subtle">
          {selectionLabel}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OnboardingActionButton
          action={controller.actions.pickLocal}
          label={formatOnboardingMessage(intl, "onboarding.workspace.pickLocal")}
          intl={intl}
          ref={controller.focus.ref("pickLocal")}
        />
        <OnboardingActionButton
          action={controller.actions.openRemote}
          label={formatOnboardingMessage(intl, "onboarding.workspace.openRemote")}
          intl={intl}
          ref={controller.focus.ref("pickLocal")}
        />
        <OnboardingActionButton
          action={controller.actions.clearSelection}
          label={formatOnboardingMessage(intl, "onboarding.workspace.clearSelection")}
          intl={intl}
          variant="ghost"
          ref={controller.focus.ref("pickLocal")}
        />
      </div>
    </section>
  );
}

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  nek: "nek",
  account: "账号",
  workspace: "工作区",
};

export function OnboardingStepBody({ controller }: { controller: OnboardingController }) {
  switch (controller.view.currentStep) {
    case "nek":
      return <NekStep controller={controller} />;
    case "account":
      return <AccountStep controller={controller} />;
    case "workspace":
      return <WorkspaceStep controller={controller} />;
  }
}
