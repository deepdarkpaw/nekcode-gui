// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
