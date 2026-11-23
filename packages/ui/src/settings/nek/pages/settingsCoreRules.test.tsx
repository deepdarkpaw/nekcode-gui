// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NekSettingsView } from "@zcode/shared/nek-protocol";
import { createNekTestEnv, installDomPolyfills } from "../test/nekTestUtils.js";
import { AdvancedPage } from "./AdvancedPage.js";
import { CompactionPage } from "./CompactionPage.js";
import { ToolsPage } from "./ToolsPage.js";

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

it("SR-5 shows explicit empty defaultTools as off and toggles web search without enabling other tools", async () => {
  const env = createNekTestEnv();
  const machine = env.config.machines.get("local")!;
  machine.settings.value.defaultTools = [];
  render(<ToolsPage />, { wrapper: env.wrapper });
  const web = await screen.findByRole("switch", { name: "启用联网搜索" });
  expect(web.getAttribute("aria-checked")).toBe("false");
  expect(
    screen
      .getAllByRole("checkbox")
      .every((checkbox) => checkbox.getAttribute("aria-checked") === "false"),
  ).toBe(true);
  await act(async () => fireEvent.click(web));
  expect(machine.settings.value.defaultTools).toEqual(["web_search"]);
  await act(async () => fireEvent.click(web));
  expect(machine.settings.value.defaultTools).toEqual([]);
});

it("SR-5 diagnoses and keeps unknown entries verbatim when editing an explicit list", async () => {
  const env = createNekTestEnv();
  const machine = env.config.machines.get("local")!;
  machine.settings.value.defaultTools = ["read", "  +future_tool "];
  render(<ToolsPage />, { wrapper: env.wrapper });
  expect(await screen.findByText(/defaultTools 中的.*future_tool.*原样保留/)).toBeDefined();
  const read = within(screen.getByText("read").closest("label")!).getByRole("checkbox");
  await act(async () => fireEvent.click(read));
  expect(machine.settings.value.defaultTools).toEqual(["read", "-read", "  +future_tool "]);
  expect(
    screen
      .getAllByRole("checkbox")
      .every((checkbox) => checkbox.getAttribute("aria-checked") === "false"),
  ).toBe(true);
  expect(screen.getByRole("switch", { name: "启用联网搜索" }).getAttribute("aria-checked")).toBe(
    "false",
  );
});

it("SR-6 shows inherited SDK options and deletes only the provider overrides on reset", async () => {
  const env = createNekTestEnv();
  const machine = env.config.machines.get("local")!;
  machine.settings.value.retry = { maxRetries: 2 };
  const mockRead = env.config.readSettings;
  vi.spyOn(env.config, "readSettings").mockImplementation(async (...args) => {
    const data = await mockRead(...args);
    const provider = { maxRetryDelayMs: 60000 };
    return {
      ...data,
      defaults: { ...data.defaults, retry: { ...data.defaults.retry, provider } },
      effective: {
        ...data.effective,
        retry: {
          ...data.effective.retry,
          provider: { ...provider, ...data.values.retry?.provider },
        },
      },
    };
  });
  render(<AdvancedPage />, { wrapper: env.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "服务商请求层" }));
  const timeout = (await screen.findByLabelText("请求超时")) as HTMLInputElement;
  const retries = screen.getByLabelText<HTMLInputElement>("SDK 重试次数");
  const cap = screen.getByLabelText<HTMLInputElement>("SDK 最长退避");
  for (const input of [timeout, retries]) {
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("SDK 默认");
  }
  expect(cap.value).toBe("60000");
  await act(async () => editNumber(timeout, "4500"));
  await act(async () => editNumber(retries, "0"));
  await act(async () => editNumber(cap, "9000"));
  expect(machine.settings.value.retry).toEqual({
    maxRetries: 2,
    provider: { timeoutMs: 4500, maxRetries: 0, maxRetryDelayMs: 9000 },
  });
  for (const input of [timeout, retries, cap]) {
    const row = input.closest<HTMLElement>("[data-slot='setting-row']")!;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "恢复默认" })));
  }
  expect(machine.settings.value.retry).toEqual({ maxRetries: 2 });
  expect(timeout.value).toBe("");
  expect(retries.value).toBe("");
  expect(cap.value).toBe("60000");
});

it("SR-8 advanced timeout uses the same numeric-string parsing as nek", async () => {
  const env = createNekTestEnv();
  const patch = vi.spyOn(env.config, "patchSettings");
  render(<AdvancedPage />, { wrapper: env.wrapper });
  const input = await screen.findByLabelText("空闲超时");
  editNumber(input, "-1");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(patch).not.toHaveBeenCalled();
  await act(async () => editNumber(input, " disabled "));
  expect(env.config.machines.get("local")!.settings.value.httpIdleTimeoutMs).toBe("disabled");
  await act(async () => editNumber(input, "15.5"));
  expect(env.config.machines.get("local")!.settings.value.httpIdleTimeoutMs).toBe(15.5);
});
