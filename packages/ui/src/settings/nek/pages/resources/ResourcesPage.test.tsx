// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NekConfigTarget, NekResourceType } from "@zcode/shared/nek-protocol";
import { ResourceDialog } from "./ResourceDialog.js";
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

it.each(["review_pr", "代码审查", "Fix.Issue"])(
  "NM-3 creates /%s while rejecting whitespace at the name field",
  async (name) => {
    const env = createNekTestEnv();
    const create = vi.spyOn(env.config, "createResource");
    render(
      <ResourceDialog
        editor={{ kind: "create", scope: "global" }}
        query={{ resourceType: "prompts" }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
      { wrapper: env.wrapper },
    );
    const field = screen.getByRole("textbox", { name: "名称" });
    const save = screen.getByRole("button", { name: "新建命令模板" });
    fireEvent.change(screen.getByLabelText("Markdown 正文"), { target: { value: "Review $1" } });
    fireEvent.change(field, { target: { value: `${name} args` } });
    fireEvent.click(save);
    expect(create).not.toHaveBeenCalled();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/空白分隔命令和参数/u)).toBeTruthy();
    fireEvent.change(field, { target: { value: name } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(LOCAL, expect.objectContaining({ name })),
    );
  },
);

it("NM-4 shows skill name and description errors at their fields before creating", async () => {
  const env = createNekTestEnv();
  const create = vi.spyOn(env.config, "createResource");
  render(
    <ResourceDialog
      editor={{ kind: "create", scope: "global" }}
      query={{ resourceType: "skills" }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
    { wrapper: env.wrapper },
  );
  const name = screen.getByRole("textbox", { name: "名称" });
  const description = screen.getByRole("textbox", { name: "描述" });
  fireEvent.change(name, { target: { value: "two--hyphens" } });
  fireEvent.change(description, { target: { value: "x".repeat(1025) } });
  fireEvent.change(screen.getByLabelText("Markdown 正文"), { target: { value: "Instructions" } });
  const save = screen.getByRole("button", { name: "新建技能" });
  fireEvent.click(save);
  expect(create).not.toHaveBeenCalled();
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(description.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(/连续的连字符/u)).toBeTruthy();
  expect(screen.getByText(/描述不能超过 1024/u)).toBeTruthy();
  fireEvent.change(name, { target: { value: "valid-skill" } });
  fireEvent.change(description, { target: { value: "Description" } });
  fireEvent.click(save);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
});

it("NM-4 keeps a legacy skill visible beside its original nek warning", async () => {
  const env = createNekTestEnv();
  const query = { resourceType: "skills" } as const;
  const catalog = await env.config.listConfigResources(LOCAL, query);
  const warning = "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)";
  const path = `${catalog.roots.global}/Legacy_Name/SKILL.md`;
  vi.spyOn(env.config, "listConfigResources").mockResolvedValue({
    ...catalog,
    resources: [{ ...catalog.resources[0]!, name: "Legacy_Name", path }],
    diagnostics: [{ type: "warning", message: warning, path }],
  });
  render(<ResourcesPage resourceType="skills" />, { wrapper: env.wrapper });
  expect(await screen.findByRole("switch", { name: "启用 Legacy_Name" })).toBeTruthy();
  const warningItem = (await screen.findByText(warning)).closest("li")!;
  expect(within(warningItem).getByText(path)).toBeTruthy();
  expect(warningItem.querySelector(".text-warning")).not.toBeNull();
});
