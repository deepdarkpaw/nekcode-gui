// @vitest-environment happy-dom
/**
 * 服务商级 api 不写、每个模型自带 api（同一网关混用 OpenAI 与 Anthropic 端点）是 nek 的合法写法：
 * 设置页要显示模型的端点而不是空标签，编辑服务商时不能凭空写入一个服务商级端点。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NekProviderConfig, NekProviderView } from "@zcode/shared/nek-protocol";
import { createNekTestEnv, installDomPolyfills, type NekTestEnv } from "../../test/nekTestUtils.js";
import { providerApiLabel, summarizeProviderApi } from "./providerApi.js";
import {
  draftEndpointApi,
  providerDraftFromView,
  providerWriteFromDraft,
  requestDraftFromDraft,
} from "./providerDraft.js";
import { ProvidersPage } from "./ProvidersPage.js";

const gateway: NekProviderConfig = {
  id: "gateway",
  name: "Gateway",
  api: "",
  baseUrl: "https://gateway.example/v1",
  apiKey: "sk-gateway-0000",
  models: [
    { id: "chat-model", api: "anthropic-messages" },
    { id: "responses-model", api: "openai-responses" },
  ],
};

function view(config: NekProviderConfig): NekProviderView {
  const { apiKey: _apiKey, ...rest } = config;
  return { ...rest, apiKey: { kind: "literal", masked: "••••0000" }, overridesBuiltin: false };
}

const label = (id: string) => `<${id}>`;

describe("provider endpoint summary", () => {
  it("prefers the provider api, then a shared model api, then marks mixed models", () => {
    expect(summarizeProviderApi({ api: "openai-completions", models: gateway.models })).toEqual({
      kind: "api",
      api: "openai-completions",
    });
    expect(summarizeProviderApi({ api: "", models: [gateway.models[0]!] })).toEqual({
      kind: "api",
      api: "anthropic-messages",
    });
    expect(providerApiLabel(gateway, "full", label)).toBe("<settings.nek.provider.api.perModel>");
    expect(providerApiLabel({ api: "", models: [{ id: "x" }] }, "short", label)).toBeNull();
    expect(providerApiLabel({ api: "bedrock-converse-stream", models: [] }, "full", label)).toBe(
      "bedrock-converse-stream",
    );
  });

  it("keeps an unset provider api unset through the edit draft", () => {
    const draft = providerDraftFromView(view(gateway));
    expect(draft.api).toBe("");
    expect(draftEndpointApi(draft)).toBe("anthropic-messages");
    expect("api" in providerWriteFromDraft(draft, view(gateway))).toBe(false);
    expect(requestDraftFromDraft(draft).api).toBe("anthropic-messages");
    expect(providerWriteFromDraft({ ...draft, api: "openai-completions" }).api).toBe(
      "openai-completions",
    );
  });
});

describe("ProvidersPage with per-model endpoints", () => {
  let env: NekTestEnv;

  beforeEach(() => {
    installDomPolyfills();
    env = createNekTestEnv();
    const machine = env.config.machines.get("local");
    if (!machine) throw new Error("missing local mock machine");
    machine.models.value = [structuredClone(gateway), ...machine.models.value];
  });
  afterEach(() => cleanup());

  it("labels the provider by its models' endpoints instead of an empty api", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    const list = await screen.findByRole("listbox", { name: "服务商" });
    const option = within(list).getByRole("option", { name: /Gateway/ });
    expect(option.textContent).toContain("按模型设置");
    const header = await screen.findByRole("heading", { name: "Gateway" });
    expect(header.parentElement?.textContent).toContain("gateway·按模型设置");
  });

  it("saves edits without inventing a provider-level api", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByRole("heading", { name: "Gateway" });
    fireEvent.click(screen.getByRole("button", { name: "编辑服务商" }));
    const dialog = await screen.findByRole("dialog");
    const unset = within(dialog).getByRole("radio", { name: "不设置（按模型）" });
    expect(unset.getAttribute("aria-checked")).toBe("true");
    fireEvent.change(within(dialog).getByLabelText(/Base URL/), {
      target: { value: "https://gateway.example/v2" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "保存服务商" }));
    });
    await waitFor(() =>
      expect(env.config.machines.get("local")?.models.value[0]?.baseUrl).toBe(
        "https://gateway.example/v2",
      ),
    );
    const saved = env.config.machines.get("local")?.models.value[0];
    expect(saved?.api).toBe("");
    expect(saved?.models.map((model) => model.api)).toEqual([
      "anthropic-messages",
      "openai-responses",
    ]);
  });
});
