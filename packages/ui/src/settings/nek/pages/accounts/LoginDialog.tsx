/**
 * 登录对话框：同时提供"浏览器自动回调"与"粘贴授权码"；Codex 额外显示设备码。
 * 可复制登录链接，随时可取消（关闭对话框即取消登录）。
 */
import { useState, type FormEvent } from "react";
import { CheckCircle2Icon, ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekHostApi } from "../../api/NekSettingsContext.js";
import type { LoginActive, LoginState } from "../../api/useNekLogin.js";
import { CopyButton } from "../../components/inputs.js";

function PromptForm({
  state,
  onAnswer,
}: {
  state: LoginActive;
  onAnswer: (value: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState("");
  const prompt = state.prompt?.payload.prompt;
  if (!prompt) {
    return null;
  }
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (value.trim() !== "" && !state.answering) {
      void onAnswer(value.trim());
    }
  };
  if (prompt.type === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-ui-sm text-foreground">{prompt.message}</p>
        {prompt.options.map((option) => (
          <Button
            key={option.id}
            variant="outline"
            className="justify-start"
            onClick={() => void onAnswer(option.id)}
          >
            {option.label}
            {option.description ? (
              <span className="ml-2 text-foreground-subtle">{option.description}</span>
            ) : null}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      <label htmlFor="nek-login-code" className="text-ui-sm font-medium text-foreground">
        {prompt.type === "manual_code"
          ? intl.formatMessage({ id: "settings.nek.login.pasteCode" })
          : prompt.message}
      </label>
      <div className="flex items-center gap-2">
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          id="nek-login-code"
          type={prompt.type === "secret" ? "password" : "text"}
          value={value}
          placeholder={prompt.placeholder}
          readOnly={state.answering}
          className="font-mono"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isImeComposing(event)) {
              event.preventDefault();
            }
          }}
        />
        <Button type="submit" variant="secondary" disabled={value.trim() === "" || state.answering}>
          {state.answering ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
          {intl.formatMessage({ id: "settings.nek.login.submitCode" })}
        </Button>
      </div>
      {prompt.type === "manual_code" ? (
        <p className="text-ui-sm text-foreground-subtle">{prompt.message}</p>
      ) : null}
    </form>
  );
}

function ActiveBody({
  state,
  onAnswer,
}: {
  state: LoginActive;
  onAnswer: (value: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const host = useNekHostApi();
  return (
    <div className="flex flex-col gap-4">
      {state.forwardedPorts.length > 0 ? (
        <p className="rounded-lg bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.nek.login.forwarded" },
            { ports: state.forwardedPorts.join(", ") },
          )}
        </p>
      ) : null}
      {state.deviceCode ? (
        <section className="flex flex-col gap-2 rounded-xl border border-card-border bg-card p-4">
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.nek.login.deviceTitle" })}
          </h3>
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-surface px-3 py-1.5 font-mono text-ui-xl tracking-widest">
              {state.deviceCode.userCode}
            </code>
            <CopyButton
              text={state.deviceCode.userCode}
              label={intl.formatMessage({ id: "settings.nek.login.copyCode" })}
            />
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.nek.login.deviceHint" },
              { url: state.deviceCode.verificationUri },
            )}
          </p>
        </section>
      ) : null}
      {state.authUrl ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.nek.login.browserTitle" })}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <AsyncButton
              icon={<ExternalLinkIcon />}
              successFeedback="none"
              onClick={() => host.openExternal(state.authUrl?.url ?? "")}
            >
              {intl.formatMessage({ id: "settings.nek.login.openBrowser" })}
            </AsyncButton>
            <CopyButton
              text={state.authUrl.url}
              label={intl.formatMessage({ id: "settings.nek.login.copyLink" })}
            />
            <span
              className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle"
              role="status"
            >
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.nek.login.waiting" })}
            </span>
          </div>
          <p className="break-all font-mono text-ui-xs text-foreground-subtlest">
            {state.authUrl.url}
          </p>
        </section>
      ) : null}
      <PromptForm key={state.prompt?.promptId ?? "none"} state={state} onAnswer={onAnswer} />
      {state.infos.map((info, index) => (
        <p key={`${index}-${info.message}`} className="text-ui-sm text-foreground-subtle">
          {info.message}
        </p>
      ))}
      {state.progress ? (
        <p className="text-ui-sm text-foreground-subtle">{state.progress}</p>
      ) : null}
    </div>
  );
}

export function LoginDialog({
  state,
  providerName,
  onAnswer,
  onCancel,
  onRetry,
  onClose,
}: {
  state: LoginState;
  providerName: string;
  onAnswer: (value: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const open = state.phase !== "idle" && state.phase !== "cancelled";
  const focusRestore = useFocusRestore(open);
  const running = state.phase === "starting" || state.phase === "active";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          void (running ? onCancel() : Promise.resolve(onClose()));
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
        <DialogHeader className="pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.nek.login.title" }, { provider: providerName })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.nek.login.description" })}
          </DialogDescription>
        </DialogHeader>
        {state.phase === "starting" ? (
          <p role="status" className="flex items-center gap-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.login.starting" })}
          </p>
        ) : null}
        {state.phase === "active" ? <ActiveBody state={state} onAnswer={onAnswer} /> : null}
        {state.phase === "done" ? (
          <p role="status" className="flex items-center gap-2 text-ui-base text-foreground">
            <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.login.done" })}
          </p>
        ) : null}
        {state.phase === "failed" ? (
          <p role="alert" className="flex items-start gap-2 text-ui-base text-destructive">
            <XCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {state.message}
          </p>
        ) : null}
        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={() => void onCancel()}>
              {intl.formatMessage({ id: "settings.nek.login.cancel" })}
            </Button>
          ) : null}
          {state.phase === "failed" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {intl.formatMessage({ id: "common.close" })}
              </Button>
              <Button onClick={onRetry}>
                {intl.formatMessage({ id: "settings.nek.login.retry" })}
              </Button>
            </>
          ) : null}
          {state.phase === "done" ? (
            <Button onClick={onClose}>
              {intl.formatMessage({ id: "settings.nek.login.finish" })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
