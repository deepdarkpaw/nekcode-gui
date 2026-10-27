/**
 * 账号登录：Claude（provider `anthropic`）与 ChatGPT（Codex，provider `openai-codex`）两张卡片。
 * 状态按 `auth_status` 的 `state` 显示：未登录 / 已登录（到期时间，nek 自动刷新）/
 * 令牌已过期 / 刷新失败 —— 后两种都提示重新登录。
 */
import { useState } from "react";
import { LogInIcon } from "lucide-react";
import type { NekAuthProviderStatus } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/lib/displayFormat.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { useNekLogin } from "../../api/useNekLogin.js";
import { useNekQuery } from "../../api/useNekQuery.js";
import { DocumentGate } from "../../components/DocumentStatus.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { NekProviderLogo } from "../../components/NekProviderLogo.js";
import { LoginDialog } from "./LoginDialog.js";

interface AccountCard {
  provider: "anthropic" | "openai-codex";
  titleId: string;
  descriptionId: string;
  noticeId?: string;
}

const ACCOUNT_CARDS: readonly AccountCard[] = [
  {
    provider: "anthropic",
    titleId: "settings.nek.accounts.claude.title",
    descriptionId: "settings.nek.accounts.claude.description",
    noticeId: "settings.nek.accounts.claude.notice",
  },
  {
    provider: "openai-codex",
    titleId: "settings.nek.accounts.codex.title",
    descriptionId: "settings.nek.accounts.codex.description",
  },
];

export type AccountState =
  | "loggedOut"
  | "loggedIn"
  | "expired"
  | "refreshFailed"
  | "otherCredential";

/**
 * 账号状态：以 nek 的 `state` 为准（`expired` / `refresh_failed` 都需要重新登录）。
 * `expiresAt` 只做兜底：后端已经按到期时间推出 `expired`，这里再算一次是为了旧数据。
 */
export function accountStateOf(
  status: NekAuthProviderStatus | undefined,
  now = Date.now(),
): AccountState {
  if (!status || status.kind === "none") {
    return "loggedOut";
  }
  if (status.kind !== "oauth") {
    return "otherCredential";
  }
  if (status.state === "refresh_failed") {
    return "refreshFailed";
  }
  if (status.state === "expired") {
    return "expired";
  }
  if (status.expiresAt && Date.parse(status.expiresAt) <= now) {
    return "expired";
  }
  return "loggedIn";
}

const STATE_DOT: Record<AccountState, string> = {
  loggedOut: "bg-foreground-subtlest",
  loggedIn: "bg-success",
  expired: "bg-warning",
  refreshFailed: "bg-destructive",
  otherCredential: "bg-icon-blue",
};

function AccountCardView({
  card,
  status,
  onLogin,
  onLogout,
}: {
  card: AccountCard;
  status: NekAuthProviderStatus | undefined;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const { intl } = useZCodeIntl();
  const state = accountStateOf(status);
  const expires = status?.expiresAt ? formatDateTime(Date.parse(status.expiresAt)) : "";
  return (
    <section
      aria-labelledby={`nek-account-${card.provider}`}
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4"
    >
      <header className="flex items-start gap-3">
        <NekProviderLogo hint={card.provider} className="size-8 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3
            id={`nek-account-${card.provider}`}
            className="text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: card.titleId })}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: card.descriptionId })}
          </p>
        </div>
      </header>
      <p className="flex items-center gap-2 text-ui-sm text-foreground" role="status">
        <span aria-hidden="true" className={`size-2 rounded-full ${STATE_DOT[state]}`} />
        {intl.formatMessage({ id: `settings.nek.accounts.state.${state}` }, { expires })}
      </p>
      {state === "loggedIn" ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.accounts.autoRefresh" })}
        </p>
      ) : null}
      {state === "expired" || state === "refreshFailed" ? (
        <p role="alert" className="text-ui-sm text-warning">
          {intl.formatMessage({ id: `settings.nek.accounts.hint.${state}` })}
        </p>
      ) : null}
      {card.noticeId ? (
        <p className="rounded-lg bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: card.noticeId })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {state === "loggedOut" || state === "otherCredential" ? (
          <Button onClick={onLogin}>
            <LogInIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.accounts.login" })}
          </Button>
        ) : (
          <>
            <Button
              variant={state === "loggedIn" ? "outline" : "default"}
              onClick={onLogin}
            >
              {intl.formatMessage({ id: "settings.nek.accounts.relogin" })}
            </Button>
            <Button variant="ghost" onClick={onLogout}>
              {intl.formatMessage({ id: "settings.nek.accounts.logout" })}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

export function AccountsPage() {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target, targetInfo } = useNekTarget();
  const auth = useNekQuery((config, current) => config.getAuthStatus(current), []);
  const login = useNekLogin();
  const [loginProvider, setLoginProvider] = useState<AccountCard | null>(null);
  const [logoutProvider, setLogoutProvider] = useState<AccountCard | null>(null);

  const startLogin = (card: AccountCard) => {
    setLoginProvider(card);
    void login.start(card.provider);
  };

  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.accounts.pageDescription" })}
    >
      <DocumentGate documents={[auth]}>
        {() => (
          <div className="grid gap-4 md:grid-cols-2">
            {ACCOUNT_CARDS.map((card) => (
              <AccountCardView
                key={card.provider}
                card={card}
                status={auth.data?.find((item) => item.provider === card.provider)}
                onLogin={() => startLogin(card)}
                onLogout={() => setLogoutProvider(card)}
              />
            ))}
          </div>
        )}
      </DocumentGate>
      <LoginDialog
        state={login.state}
        providerName={loginProvider ? intl.formatMessage({ id: loginProvider.titleId }) : ""}
        onAnswer={login.answer}
        onCancel={login.cancel}
        onRetry={() => loginProvider && startLogin(loginProvider)}
        onClose={login.reset}
      />
      <NekConfirmDialog
        open={logoutProvider !== null}
        onOpenChange={(open) => !open && setLogoutProvider(null)}
        title={intl.formatMessage(
          { id: "settings.nek.accounts.logoutTitle" },
          { provider: logoutProvider ? intl.formatMessage({ id: logoutProvider.titleId }) : "" },
        )}
        description={intl.formatMessage(
          { id: "settings.nek.accounts.logoutDescription" },
          { host: targetInfo?.label ?? "" },
        )}
        confirmLabel={intl.formatMessage({ id: "settings.nek.accounts.logout" })}
        destructive
        onConfirm={async () => {
          if (logoutProvider) {
            await api.logout(target, logoutProvider.provider);
            await auth.reload();
          }
        }}
      />
    </NekPageFrame>
  );
}
