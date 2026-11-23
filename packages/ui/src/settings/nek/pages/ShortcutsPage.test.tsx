// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { createNekTestEnv, installDomPolyfills, type NekTestEnv } from "../test/nekTestUtils.js";
import { ShortcutsPage } from "./ShortcutsPage.js";

let env: NekTestEnv;

beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
});
afterEach(() => cleanup());

describe("ShortcutsPage recording", () => {
  it.each([
    ["app.editor.external", "当前 GUI 尚未接通外部编辑器"],
    ["gui.interaction.focus", "待回答请求的焦点由交互卡片自己维护，暂不支持快捷键聚焦"],
  ])("SC-7 leaves recording and clearing disabled for %s and explains why", (actionId, reason) => {
    render(<ShortcutsPage />, { wrapper: env.wrapper });
    const row = screen.getByText(actionId).closest<HTMLElement>("[data-nek-row]")!;
    const record = within(row).getByRole<HTMLButtonElement>("button", { name: "录制" });
    const clear = within(row).getByRole<HTMLButtonElement>("button", { name: "清除快捷键" });
    expect(within(row).getByRole("status").textContent).toBe(reason);
    expect(record.disabled).toBe(true);
    expect(clear.disabled).toBe(true);
    fireEvent.click(record);
    fireEvent.click(clear);
    expect(isShortcutRecordingActive()).toBe(false);
    expect(within(row).queryByText("未设置")).toBeNull();
  });

  it("SC-7 leaves IME composition alone while recording", async () => {
    render(<ShortcutsPage />, { wrapper: env.wrapper });
    const [record] = await screen.findAllByRole("button", { name: "录制" });
    fireEvent.click(record!);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(isShortcutRecordingActive()).toBe(true);
  });
  // 动作分发器与旧命令表更早注册在同一 capture 阶段：录制期间不短路的话，
  // 录 Ctrl+K / Ctrl+N 会先真的打开命令面板 / 新建任务。
  it("owns the keyboard while recording and releases it on Esc", async () => {
    render(<ShortcutsPage />, { wrapper: env.wrapper });
    expect(isShortcutRecordingActive()).toBe(false);
    const [record] = await screen.findAllByRole("button", { name: "录制" });
    fireEvent.click(record!);
    expect(isShortcutRecordingActive()).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(isShortcutRecordingActive()).toBe(false);
  });

  it("releases the keyboard when the page unmounts mid-recording", async () => {
    const view = render(<ShortcutsPage />, { wrapper: env.wrapper });
    const [record] = await screen.findAllByRole("button", { name: "录制" });
    fireEvent.click(record!);
    expect(isShortcutRecordingActive()).toBe(true);
    view.unmount();
    expect(isShortcutRecordingActive()).toBe(false);
  });
});
