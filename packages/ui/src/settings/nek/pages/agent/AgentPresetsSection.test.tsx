// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNekAgentPresetsDoc } from "../../api/mcpDocs.js";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { AgentPresetsSection } from "./AgentPresetsSection.js";

beforeEach(() => installDomPolyfills());
afterEach(() => cleanup());

function Presets() {
  const doc = useNekAgentPresetsDoc();
  return (
    <AgentPresetsSection
      doc={doc}
      models={[]}
      sources={["builtin", "user"]}
      allowProjectScope={false}
      title="子代理预设"
    />
  );
}

it("AC-3 AC-4 displays bad files and retains both same-named entries with the winning path", async () => {
  const env = createNekTestEnv();
  const machine = env.config.machines.get("local")!;
  const path = `${machine.agentDir}/agents/alt-explorer.md`;
  const badFile = `${machine.agentDir}/agents/bad.md`;
  machine.presets.push({
    source: "user",
    path,
    revision: "override-explorer",
    preset: { name: "explorer", description: "My explorer" },
  });
  machine.brokenPresets = [
    {
      file: badFile,
      severity: "error",
      message: `${badFile}: "thinking" must be one of off, minimal, low, medium, high, xhigh, max`,
    },
  ];
  const open = vi.spyOn(env.host, "openPath");
  render(<Presets />, { wrapper: env.wrapper });
  expect(await screen.findByText(badFile)).toBeTruthy();
  expect(screen.getByText(/"thinking" must be one of/)).toBeTruthy();
  expect(screen.getAllByText("explorer")).toHaveLength(2);
  expect(
    screen.getByText((_, element) => element?.textContent === `已被 ${path} 覆盖`),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开文件" }));
  expect(open).toHaveBeenCalledWith({ kind: "local" }, badFile);
});

it("AC-6 copying explorer preloads and saves the full instructions", async () => {
  const env = createNekTestEnv();
  const save = vi.spyOn(env.config, "saveAgentPreset");
  render(<Presets />, { wrapper: env.wrapper });
  const row = (await screen.findByText("explorer")).closest<HTMLElement>("[data-nek-row]")!;
  fireEvent.click(within(row).getByRole("button", { name: "复制预设" }));
  const instructions = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "说明（正文）",
  });
  const exact =
    "Explore the codebase to answer the question in the task prompt. You cannot edit files: report findings, file paths, and code structure instead of changing anything. State the desired depth in your answer: quick, medium, or very thorough.";
  expect(instructions.value).toBe(exact);
  fireEvent.click(screen.getByRole("button", { name: "创建预设" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { kind: "local" },
      "global",
      expect.objectContaining({ name: "explorer-copy", instructions: exact }),
      expect.objectContaining({ revision: "absent" }),
    ),
  );
});
