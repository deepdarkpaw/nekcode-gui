// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NekConfigTarget, NekResourceType } from "@zcode/shared/nek-protocol";
import { ResourcesPage } from "./ResourcesPage.js";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { MOCK_PROJECT_CWD, MOCK_REMOTE_CONNECTED } from "../../api/mock/mockSeed.js";
import { useNekTargetSelection } from "../../api/NekSettingsContext.js";

const LOCAL = { kind: "local" } as const;
const REMOTE: NekConfigTarget = { kind: "remote", connectionId: MOCK_REMOTE_CONNECTED };

beforeEach(installDomPolyfills);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const resourceType of ["skills", "prompts"] as const satisfies readonly NekResourceType[]) {
  it(`${resourceType} shows nek groups, disabled entries, trust action, and visible retryable errors`, async () => {
    const env = createNekTestEnv();
    const query = { resourceType, cwd: MOCK_PROJECT_CWD };
    const current = await env.config.listConfigResources(LOCAL, query);
    const entry = current.resources[0]!;
    await env.config.setResourceEnabled(LOCAL, { ...query, path: entry.path, enabled: false });
    await env.config.setProjectTrust(LOCAL, MOCK_PROJECT_CWD, false);
    render(<ResourcesPage resourceType={resourceType} />, { wrapper: env.wrapper });
    const label = `启用 ${entry.name}`;
    const toggle = await screen.findByRole("switch", { name: label });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("heading", { name: "全局" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "项目" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "管理项目信任" })).toBeTruthy();
    expect(screen.getByText(/此项目未受信任/u)).toBeTruthy();
    env.config.failNext("setResourceEnabled", { code: "io", message: "nek override rejected" });
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain("nek override rejected");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it(`${resourceType} sends the selected remote target and its CLI path through the contract`, async () => {
    const env = createNekTestEnv();
    const query = { resourceType, cwd: MOCK_PROJECT_CWD };
    await env.config.setProjectTrust(REMOTE, MOCK_PROJECT_CWD, true);
    await env.config.createResource(REMOTE, {
      ...query,
      scope: "project",
      name: "remote-only",
      description: "Remote project entry",
      content: "Use this on the remote machine",
    });
    const entry = (await env.config.listConfigResources(REMOTE, query)).resources.find(
      (item) => item.name === "remote-only",
    )!;
    const toggle = vi.spyOn(env.config, "setResourceEnabled");
    render(<ResourcesPage resourceType={resourceType} />, { wrapper: env.wrapper });
    await act(async () => useNekTargetSelection.getState().setTarget(REMOTE));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 remote-only" }));
    await waitFor(() =>
      expect(toggle).toHaveBeenCalledWith(REMOTE, { ...query, path: entry.path, enabled: false }),
    );
    expect(screen.queryByText(/此项目未受信任/u)).toBeNull();
  });
}
