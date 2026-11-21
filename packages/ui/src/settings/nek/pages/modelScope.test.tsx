// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { LOCAL_TARGET, useNekTargetSelection } from "../api/NekSettingsContext.js";
import { MOCK_PROJECT_CWD, MOCK_REMOTE_CONNECTED } from "../api/mock/mockSeed.js";
import { createNekTestEnv, flushNek, installDomPolyfills } from "../test/nekTestUtils.js";
import { DefaultModelPage } from "./DefaultModelPage.js";
import { ProvidersPage } from "./providers/ProvidersPage.js";

beforeAll(installDomPolyfills);
afterEach(cleanup);

const scopeCheckbox = (model: string) =>
  screen.findByRole("checkbox", { name: `在 CLI 列表中显示 ${model}` });

async function checkedScope(model: string, checked: boolean) {
  const name = `在 CLI 列表中显示 ${model}`;
  return waitFor(() => {
    const checkbox = screen.getByRole("checkbox", { name });
    expect(checkbox.getAttribute("aria-checked")).toBe(String(checked));
    return checkbox;
  });
}

describe("CLI model scope in settings", () => {
  it.each([[], ["missing-model"]].map((patterns) => ({ patterns })))(
    "checks all models and explicitly saves the remaining ones on exclusion when none resolve ($patterns)",
    async ({ patterns }) => {
      const env = createNekTestEnv();
      const settings = await env.config.readSettings(LOCAL_TARGET, "global");
      await env.config.patchSettings(LOCAL_TARGET, "global", { enabledModels: patterns }, settings);
      const available = await env.config.listAvailableModels(LOCAL_TARGET);
      render(<ProvidersPage />, { wrapper: env.wrapper });
      await checkedScope("deepseek/deepseek-reasoner", true);
      fireEvent.click(await checkedScope("deepseek/deepseek-chat", true));
      await checkedScope("deepseek/deepseek-chat", false);
      expect((await env.config.readSettings(LOCAL_TARGET, "global")).values.enabledModels).toEqual(
        available
          .map(({ provider, id }) => `${provider}/${id}`)
          .filter((ref) => ref !== "deepseek/deepseek-chat"),
      );
      cleanup();
      render(<DefaultModelPage />, { wrapper: env.wrapper });
      await checkedScope("deepseek/deepseek-chat", false);
      fireEvent.click(screen.getByRole("button", { name: "使用全部模型" }));
      await checkedScope("deepseek/deepseek-chat", true);
      expect((await env.config.getModelScope(LOCAL_TARGET)).patterns).toEqual([]);
    },
  );

  it("shows the resolved-empty explanation and preserves the original no-match diagnostic", async () => {
    const env = createNekTestEnv();
    const settings = await env.config.readSettings(LOCAL_TARGET, "global");
    await env.config.patchSettings(
      LOCAL_TARGET,
      "global",
      { enabledModels: ["missing-model"] },
      settings,
    );
    render(<DefaultModelPage />, { wrapper: env.wrapper });
    const notice = await screen.findByText(
      "CLI 模型列表的模式没有匹配任何模型，当前按全部模型显示。",
    );
    expect(notice.getAttribute("role")).toBe("status");
    expect(screen.getByText(/No models match pattern "missing-model"/)).toBeDefined();
    await checkedScope("deepseek/deepseek-chat", true);
    expect((await env.config.getModelScope(LOCAL_TARGET)).patterns).toEqual(["missing-model"]);
  });

  it("shows nek diagnostics and keeps explicit reasoning on remaining glob matches", async () => {
    const env = createNekTestEnv();
    const settings = await env.config.readSettings(LOCAL_TARGET, "global");
    await env.config.patchSettings(
      LOCAL_TARGET,
      "global",
      { enabledModels: ["deepseek/*:high", "missing-model", "claude-sonnet-4-5"] },
      settings,
    );
    render(<DefaultModelPage />, { wrapper: env.wrapper });
    expect(await screen.findByText(/No models match pattern "missing-model"/)).toBeDefined();
    expect(await screen.findByText(/matches several providers/)).toBeDefined();
    fireEvent.click(await scopeCheckbox("deepseek/deepseek-chat"));
    await waitFor(async () =>
      expect((await env.config.getModelScope(LOCAL_TARGET)).patterns[0]).toBe(
        "deepseek/deepseek-reasoner:high",
      ),
    );
  });

  it("one remaining model cannot be disabled accidentally", async () => {
    const env = createNekTestEnv();
    const settings = await env.config.readSettings(LOCAL_TARGET, "global");
    await env.config.patchSettings(
      LOCAL_TARGET,
      "global",
      { enabledModels: ["deepseek/deepseek-chat"] },
      settings,
    );
    render(<ProvidersPage />, { wrapper: env.wrapper });
    const checkbox = await checkedScope("deepseek/deepseek-chat", true);
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(checkbox.title).toContain("至少保留一个模型");
  });

  it("keeps model management usable on a scope error, then retries read and write visibly", async () => {
    const env = createNekTestEnv();
    env.config.failNext("getModelScope", { code: "io", message: "scope RPC offline" });
    render(<ProvidersPage />, { wrapper: env.wrapper });
    expect(await screen.findByText("scope RPC offline")).toBeDefined();
    expect(screen.getByRole("button", { name: "手动添加" })).toBeDefined();
    const checkbox = await scopeCheckbox("deepseek/deepseek-reasoner");
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const excluded = await checkedScope("deepseek/deepseek-reasoner", false);
    env.config.failNext("saveModelScope", { code: "io", message: "settings lock denied" });
    fireEvent.click(excluded);
    expect(await screen.findByText("settings lock denied")).toBeDefined();
    fireEvent.click(await checkedScope("deepseek/deepseek-reasoner", false));
    await checkedScope("deepseek/deepseek-reasoner", true);
  });

  it("reads and updates only the matching target's project scope", async () => {
    const remote: NekConfigTarget = { kind: "remote", connectionId: MOCK_REMOTE_CONNECTED };
    const first = createNekTestEnv();
    const { remoteEnvironmentKey } = (await first.config.listTargets()).find(
      ({ target }) => target.kind === "remote" && target.connectionId === MOCK_REMOTE_CONNECTED,
    )!;
    const env = createNekTestEnv({ projectEnvironmentKey: remoteEnvironmentKey });
    const global = await env.config.readSettings(remote, "global");
    const project = await env.config.readSettings(remote, "project", MOCK_PROJECT_CWD);
    await env.config.patchSettings(
      remote,
      "global",
      { enabledModels: ["not-a-remote-model"] },
      global,
    );
    await env.config.patchSettings(
      remote,
      "project",
      { enabledModels: ["openrouter/anthropic/claude-sonnet-4.5"] },
      { ...project, cwd: MOCK_PROJECT_CWD },
    );
    await env.config.setProjectTrust(remote, MOCK_PROJECT_CWD, true);
    const readScope = vi.spyOn(env.config, "getModelScope");
    render(<DefaultModelPage />, { wrapper: env.wrapper });
    await scopeCheckbox("deepseek/deepseek-chat");
    expect(readScope).toHaveBeenCalledWith(LOCAL_TARGET, undefined);
    act(() => useNekTargetSelection.setState({ target: remote }));
    const checkbox = await scopeCheckbox("openrouter/anthropic/claude-sonnet-4.5");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(readScope).toHaveBeenCalledWith(remote, MOCK_PROJECT_CWD);
    fireEvent.click(screen.getByRole("button", { name: "使用全部模型" }));
    await flushNek();
    expect(
      (await env.config.readSettings(remote, "project", MOCK_PROJECT_CWD)).values.enabledModels,
    ).toEqual([]);
    expect((await env.config.readSettings(remote, "global")).values.enabledModels).toEqual([
      "not-a-remote-model",
    ]);
  });
});
