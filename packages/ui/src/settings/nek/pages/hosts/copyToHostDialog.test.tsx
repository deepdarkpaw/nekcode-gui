// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CopyToHostDialog } from "./CopyToHostDialog.js";
import { createNekTestEnv, installDomPolyfills, type NekTestEnv } from "../../test/nekTestUtils.js";
import { MOCK_REMOTE_CONNECTED } from "../../api/mock/mockSeed.js";

let env: NekTestEnv;

beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
});
afterEach(() => cleanup());

const TARGET = { kind: "remote", connectionId: MOCK_REMOTE_CONNECTED } as const;

function renderDialog() {
  const onOpenChange = vi.fn();
  render(
    <CopyToHostDialog open onOpenChange={onOpenChange} target={TARGET} hostLabel="dev-box" />,
    { wrapper: env.wrapper },
  );
  return { onOpenChange };
}

describe("CopyToHostDialog", () => {
  it("shows per-item results and retries the failed items", async () => {
    env.config.failCopyItem("provider:deepseek", "disk full");
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/DeepSeek/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /预览 \d+ 项/ }));
    });
    const copyButton = await within(dialog).findByRole("button", { name: /复制 \d+ 项/ });
    await act(async () => {
      fireEvent.click(copyButton);
    });

    // 逐项结果：失败项给出原因，其他项照常完成。
    expect(await within(dialog).findByText("disk full")).toBeDefined();
    expect(within(dialog).getByText("失败")).toBeDefined();
    expect(
      env.config.machines
        .get(`remote:${MOCK_REMOTE_CONNECTED}`)
        ?.models.value.some((provider) => provider.id === "deepseek"),
    ).toBe(false);

    // 重试后该项成功写入目标机器，失败计数归零。
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "重试复制" }));
    });
    const summary = await within(dialog).findByText(/失败 0 项/);
    expect(summary.textContent).toContain("失败 0 项");
    expect(
      env.config.machines
        .get(`remote:${MOCK_REMOTE_CONNECTED}`)
        ?.models.value.some((provider) => provider.id === "deepseek"),
    ).toBe(true);
  });
});
