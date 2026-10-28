import { describe, expect, it } from "vitest";
import type { NekAuthProviderStatus, NekProviderView } from "@zcode/shared/nek-protocol";
import { createOnboardingAccountView } from "./onboardingAccountController.js";
import {
  isOnboardingAccountComplete,
  isUsableNekAuthStatus,
  isUsableNekProvider,
} from "./onboardingAccount.js";

const provider = (apiKey: NekProviderView["apiKey"]): NekProviderView => ({
  id: "demo",
  name: "Demo",
  api: "openai-completions",
  baseUrl: "https://example.com/v1",
  apiKey,
  models: [{ id: "model" }],
  overridesBuiltin: false,
});

const oauth = (state: NekAuthProviderStatus["state"]): NekAuthProviderStatus => ({
  provider: "anthropic",
  name: "Claude",
  kind: "oauth",
  state,
  loginMethods: ["oauth"],
});

describe("onboarding account completion", () => {
  it("AC-2: only an ok OAuth status is usable", () => {
    expect(isUsableNekAuthStatus(oauth("ok"))).toBe(true);
    expect(isUsableNekAuthStatus(oauth("expired"))).toBe(false);
    expect(isUsableNekAuthStatus(oauth("refresh_failed"))).toBe(false);
  });

  it("AC-1/AC-5: a configured provider or usable login makes the step done", () => {
    expect(
      isOnboardingAccountComplete({ authStatuses: [], providers: [provider({ kind: "env", name: "KEY" })] }),
    ).toBe(true);
    expect(isOnboardingAccountComplete({ authStatuses: [oauth("ok")], providers: [] })).toBe(true);
    expect(isOnboardingAccountComplete({ authStatuses: [oauth("expired")], providers: [] })).toBe(false);
  });

  it("AC-3: provider view is capped at five with a remainder count", () => {
    const providers = Array.from({ length: 7 }, (_, index) => provider({ kind: "env", name: `KEY_${index}` }));
    const view = createOnboardingAccountView([], providers, false);
    expect(view.providers).toHaveLength(5);
    expect(view.moreProviders).toBe(2);
  });

  it("AC-4/AC-6: incomplete state selects loginAnthropic and carries the need reason in controller policy", () => {
    const view = createOnboardingAccountView([], [], false);
    expect(view.primaryActionId).toBe("loginAnthropic");
    expect(isUsableNekProvider(provider({ kind: "none" }))).toBe(false);
  });
});
