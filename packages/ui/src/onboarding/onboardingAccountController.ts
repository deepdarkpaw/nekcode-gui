import { useCallback, useEffect, useMemo, useState } from "react";
import type { NekAuthProviderStatus, NekProviderView } from "@zcode/shared/nek-protocol";
import { useNekConfigApi } from "@/settings/nek/api/NekSettingsContext.js";
import { useOnboardingAction, type OnboardingActionHandle } from "./onboardingAction.js";
import { isOnboardingAccountComplete } from "./onboardingAccount.js";

const ACCOUNT_PROVIDERS = ["anthropic", "openai-codex"] as const;
type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export interface OnboardingAccountView {
  loading: boolean;
  error?: string;
  done: boolean;
  logins: ReadonlyArray<{
    provider: AccountProvider;
    state: "ok" | "expired" | "refresh_failed" | "none";
    message: { id: string };
  }>;
  providers: readonly string[];
  moreProviders: number;
  primaryActionId: "loginAnthropic" | "next";
}

export interface OnboardingAccountController {
  view: OnboardingAccountView;
  actions: {
    loginAnthropic: OnboardingActionHandle;
    loginCodex: OnboardingActionHandle;
    addProvider: OnboardingActionHandle;
    refresh: OnboardingActionHandle;
  };
  reload: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loginView(status: NekAuthProviderStatus | undefined, provider: AccountProvider) {
  const state = status?.kind === "oauth" ? status.state : "none";
  return {
    provider,
    state,
    message: { id: `onboarding.account.status.${state}` },
  } as const;
}

export function createOnboardingAccountView(
  statuses: readonly NekAuthProviderStatus[],
  providers: readonly NekProviderView[],
  loading: boolean,
  error?: string,
): OnboardingAccountView {
  const done = isOnboardingAccountComplete({ authStatuses: statuses, providers });
  return {
    loading,
    error,
    done,
    logins: ACCOUNT_PROVIDERS.map((provider) =>
      loginView(
        statuses.find((item) => item.provider === provider),
        provider,
      ),
    ),
    providers: providers.slice(0, 5).map((provider) => provider.name ?? provider.id),
    moreProviders: Math.max(0, providers.length - 5),
    primaryActionId: done ? "next" : "loginAnthropic",
  };
}

export function useOnboardingAccountController(options: {
  active: boolean;
  onOpenLogin: (provider: AccountProvider) => void;
  onOpenProviderForm: () => void;
}): OnboardingAccountController {
  const config = useNekConfigApi();
  const [statuses, setStatuses] = useState<readonly NekAuthProviderStatus[]>([]);
  const [providers, setProviders] = useState<readonly NekProviderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const target = { kind: "local" } as const;
      const [nextStatuses, models] = await Promise.all([
        config.getAuthStatus(target),
        config.readModelsConfig(target),
      ]);
      setStatuses(nextStatuses);
      setProviders(models.providers);
      setLoaded(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (options.active && !loaded) void reload();
  }, [loaded, options.active, reload]);

  const view = createOnboardingAccountView(statuses, providers, loading, error);
  const busy = loading;
  const loginAnthropic = useOnboardingAction({
    action: async () => options.onOpenLogin("anthropic"),
    primary: !view.done,
    enabled: !busy,
  });
  const loginCodex = useOnboardingAction({
    action: async () => options.onOpenLogin("openai-codex"),
    enabled: !busy,
  });
  const addProvider = useOnboardingAction({
    action: async () => options.onOpenProviderForm(),
    enabled: !busy,
  });
  const refresh = useOnboardingAction({
    action: reload,
    enabled: !busy,
  });

  return useMemo(
    () => ({ view, actions: { loginAnthropic, loginCodex, addProvider, refresh }, reload }),
    [addProvider, loginAnthropic, loginCodex, refresh, reload, view],
  );
}
