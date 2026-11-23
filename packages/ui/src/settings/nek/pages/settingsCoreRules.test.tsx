// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NekSettingsView } from "@zcode/shared/nek-protocol";
import { createNekTestEnv, installDomPolyfills } from "../test/nekTestUtils.js";
import { CompactionPage } from "./CompactionPage.js";

beforeEach(installDomPolyfills);
afterEach(cleanup);

function editNumber(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
}

it.each(["工具结果上限", "工具错误上限", "工具参数上限"])(
  "SR-3 enforces a minimum of 256 in %s and keeps the default reset",
  async (label) => {
    const env = createNekTestEnv();
    const patch = vi.spyOn(env.config, "patchSettings");
    render(<CompactionPage />, { wrapper: env.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "内容折叠" }));
    const field = (await screen.findByLabelText(label)) as HTMLInputElement;
    const originalDefault = field.value;
    editNumber(field, "0");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("不能小于 256");
    expect(patch).not.toHaveBeenCalled();
    await act(async () => editNumber(field, "256"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const row = field.closest<HTMLElement>("[data-slot='setting-row']")!;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "恢复默认" })));
    await waitFor(() => expect(field.value).toBe(originalDefault));
    expect(patch).toHaveBeenCalledTimes(2);
  },
);

it("SR-3 accepts zero for a thinking budget but not an unsafe integer", async () => {
  const env = createNekTestEnv();
  const patch = vi.spyOn(env.config, "patchSettings");
  render(<CompactionPage />, { wrapper: env.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "内容折叠" }));
  const field = await screen.findByLabelText("单段 thinking 上限");
  editNumber(field, "9007199254740992");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(patch).not.toHaveBeenCalled();
  await act(async () => editNumber(field, "0"));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(
    env.config.machines.get("local")!.settings.value.compaction?.content?.thinkingMaxChars,
  ).toBe(0);
});

it("SR-2 lets the user reset only the bad field and retry a failed repair", async () => {
  const env = createNekTestEnv();
  const machine = env.config.machines.get("local")!;
  machine.settings.value.compaction = {
    content: { toolResultMaxChars: 0, typo: true, toolArgumentMaxChars: 1024 },
  } as NekSettingsView["compaction"];
  render(<CompactionPage />, { wrapper: env.wrapper });
  const rule = await screen.findByText(
    "compaction.content.toolResultMaxChars: expected a safe integer >= 256",
  );
  expect(within(rule).getByText(machine.settings.path)).toBeDefined();
  const reset = () =>
    within(rule.closest("ul")!.parentElement!.parentElement!).getByRole("button", {
      name: "恢复默认",
    });
  env.config.failNext("patchSettings", { code: "io", message: "fixture write failed" });
  await act(async () => fireEvent.click(reset()));
  await waitFor(() => expect(reset().getAttribute("data-async-state")).toBe("error"));
  await act(async () => fireEvent.click(reset()));
  await waitFor(() =>
    expect(machine.settings.value.compaction?.content).toEqual({
      typo: true,
      toolArgumentMaxChars: 1024,
    }),
  );
  expect(screen.queryByText(/compaction.content.toolResultMaxChars:/)).toBeNull();
  expect(screen.getByText(/compaction.content.typo: unknown/)).toBeDefined();
});

it("SR-4 uses the main model's exact override for the compaction threshold", async () => {
  const env = createNekTestEnv();
  env.config.machines.get("local")!.settings.value = {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    compaction: {
      reserveTokens: 8000,
      keepRecentTokens: 20000,
      modelOverrides: {
        "deepseek/deepseek-chat": { reserveTokens: 11000, keepRecentTokens: 5000 },
      },
    },
  };
  render(<CompactionPage />, { wrapper: env.wrapper });
  expect(await screen.findByText(/128k − 11k = 117k.*5k/)).toBeDefined();
});
