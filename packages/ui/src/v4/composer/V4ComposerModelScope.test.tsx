// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { TID_CHAT_MODEL_SELECT_TRIGGER } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import type { V4ComposerConfigPicker } from "./configPickerState.js";
import { V4ComposerModelControls } from "./V4ComposerToolbar.js";

vi.mock("@/hooks/useZCodeConfig.js", () => ({ useToolbarConfigOptions: () => ({}) }));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStore: () => vi.fn() }));
vi.mock("@/shortcuts/useActionShortcuts.js", () => ({ useActionShortcutLabel: () => undefined }));
vi.mock("@/shortcuts/nekActionDispatcher.js", () => ({ useNekActionHandlers: () => undefined }));

beforeAll(installDomPolyfills);
afterEach(cleanup);

const model = (id: string) => ({
  modelId: id,
  displayName: id,
  reasoningLevels: ["off"],
  supportsImage: false,
});
const available = [
  {
    providerId: "a",
    displayName: "Provider A",
    models: [model("first"), model("current"), model("hidden")],
  },
  { providerId: "b", displayName: "Provider B", models: [model("second")] },
];
// enabledModels 只影响 nek 的循环切换与子代理列表，不能过滤聊天模型菜单。
const scoped: ModelSelectionView = {
  revision: 1,
  providers: available,
  scope: {
    patterns: ["b/second", "a/first"],
    models: [
      { provider: "b", id: "second" },
      { provider: "a", id: "first" },
    ],
    diagnostics: [],
  },
};

function renderToolbar(view = scoped, state: ModelSelectionState = { status: "ready", view }) {
  const retry = vi.fn();
  const select = vi.fn();
  function Toolbar() {
    const [picker, setPicker] = useState<V4ComposerConfigPicker | null>(null);
    return (
      <V4ComposerModelControls
        workspacePath="/repo"
        sessionId={null}
        phase={null}
        usage={null}
        disabled={false}
        draftMode
        draftConfig={{
          modelSelection: {
            providerId: "a",
            modelId: "current",
            options: { reasoningLevel: "off" },
          },
        }}
        modelSelectionView={view}
        modelSelectionState={state}
        modelSelectionReload={retry}
        activeConfigPicker={picker}
        onConfigPickerOpenChange={(name, open) => setPicker(open ? name : null)}
        onSelectModel={select}
        onSelectThought={() => undefined}
        onSwitchMode={() => undefined}
      />
    );
  }
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <Toolbar />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
  return { retry, select };
}

const openMenu = () =>
  fireEvent.keyDown(screen.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER), { key: "Enter" });

describe("composer model menu", () => {
  it("lists every configured provider directly, ignoring enabledModels", async () => {
    renderToolbar();
    expect(screen.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).textContent).toContain("current");
    openMenu();
    expect(await screen.findByText("Provider A")).toBeDefined();
    expect(screen.getByText("Provider B")).toBeDefined();
    expect(screen.queryByText("显示全部模型")).toBeNull();
    expect(screen.queryByText("只显示循环范围")).toBeNull();
    expect(screen.queryByText("当前 · 范围外")).toBeNull();
  });

  it("selects a model outside enabledModels in one step", async () => {
    const { select } = renderToolbar({ ...scoped, providers: [available[0]!] });
    openMenu();
    fireEvent.click(await screen.findByText("hidden"));
    expect(select).toHaveBeenCalledWith("a", "hidden", { provider: "a", model: "current" });
  });

  it("shows the model RPC error and offers retry, not a stale menu", () => {
    const { retry } = renderToolbar(scoped, {
      status: "error",
      error: new Error("get_model_scope: RPC failed"),
    });
    expect(screen.getByRole("alert").textContent).toContain("get_model_scope: RPC failed");
    expect(screen.queryByTestId(TID_CHAT_MODEL_SELECT_TRIGGER)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "模型加载失败，重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
