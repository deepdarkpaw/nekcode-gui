// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { LOCAL_TARGET } from "../api/NekSettingsContext.js";
import { MOCK_PROJECT_CWD } from "../api/mock/mockSeed.js";
import { createNekTestEnv, installDomPolyfills } from "../test/nekTestUtils.js";
import { ProjectPage } from "./ProjectPage.js";

beforeAll(installDomPolyfills);
afterEach(cleanup);

it.each([
  { policy: "ask", cwd: MOCK_PROJECT_CWD, label: "将会询问（启动新会话时）" },
  { policy: "always", cwd: MOCK_PROJECT_CWD, label: "已信任（默认策略：总是信任）" },
  { policy: "never", cwd: MOCK_PROJECT_CWD, label: "不信任（默认策略：从不信任）" },
  { policy: "never", cwd: "/fixtures/empty-project", label: "无需决定（没有需要信任的项目配置）" },
] as const)("PT-7 shows $label under $policy", async ({ policy, cwd, label }) => {
  const env = createNekTestEnv({ projectCwd: cwd });
  const settings = await env.config.readSettings(LOCAL_TARGET, "global");
  await env.config.patchSettings(LOCAL_TARGET, "global", { defaultProjectTrust: policy }, settings);
  render(<ProjectPage />, { wrapper: env.wrapper });
  expect((await screen.findByText(label)).getAttribute("role")).toBe("status");
  expect(screen.queryByText(`${cwd}/.nek/agents`)).toBeNull();
  expect(screen.queryByRole("button", { name: /清除.*记录/ })).toBeNull();
});

it("PT-6/PT-7 trust and deny update the saved choice and project settings editing", async () => {
  const env = createNekTestEnv();
  const persist = vi.spyOn(env.config, "setProjectTrust");
  render(<ProjectPage />, { wrapper: env.wrapper });
  expect(await screen.findByText(/项目设置未生效/)).toBeDefined();
  expect(screen.queryByRole("textbox", { name: "Shell 路径" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "信任此项目" }));
  expect(await screen.findByText("已信任（已有记录）")).toBeDefined();
  expect(await screen.findByText("Shell 路径")).toBeDefined();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "不信任" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "不信任" }));
  expect(await screen.findByText("不信任（已有记录）")).toBeDefined();
  expect(await screen.findByText(/项目设置未生效/)).toBeDefined();
  expect(persist.mock.calls).toEqual([
    [LOCAL_TARGET, MOCK_PROJECT_CWD, true],
    [LOCAL_TARGET, MOCK_PROJECT_CWD, false],
  ]);
});

it("PT-7 inherited saved decisions are not treated as undecided", async () => {
  const env = createNekTestEnv();
  await env.config.setProjectTrust(LOCAL_TARGET, "/home/me/projects", true);
  render(<ProjectPage />, { wrapper: env.wrapper });
  expect(await screen.findByText("已信任（已有记录）")).toBeDefined();
  expect(screen.queryByText(/将会询问/)).toBeNull();
});
