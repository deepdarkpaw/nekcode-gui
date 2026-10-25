import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveActionTooltipText } from "./action-tooltip.js";
import { AsyncButton, resolveAsyncButtonIcon } from "./async-button.js";
import { IconButton } from "./icon-button.js";
import { InlineEdit } from "./inline-edit.js";
import { SettingAdvancedGroup, SettingSection, SettingSwitchField } from "./setting-fields.js";
import { SettingNumberField, SettingTextField } from "./setting-text-field.js";
import { TooltipProvider } from "./tooltip.js";
import { createUndoGate } from "./undo-toast.js";

function renderWithProviders(node: ReactNode): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{node}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("resolveActionTooltipText", () => {
  it("uses the detail as description when a label exists", () => {
    expect(resolveActionTooltipText("删除", "没有权限")).toEqual({
      title: "删除",
      description: "没有权限",
    });
  });

  it("promotes the detail to title without a label and skips empty tooltips", () => {
    expect(resolveActionTooltipText(undefined, "没有权限")).toEqual({ title: "没有权限" });
    expect(resolveActionTooltipText(undefined, undefined)).toBe(null);
  });
});

describe("AsyncButton", () => {
  it("swaps the leading icon by state", () => {
    const icon = <span data-testid="icon" />;
    expect(resolveAsyncButtonIcon({ status: "idle" }, icon)).toBe(icon);
    expect(resolveAsyncButtonIcon({ status: "pending" }, icon)).not.toBe(icon);
    expect(resolveAsyncButtonIcon({ status: "error", message: "x" }, icon)).not.toBe(icon);
  });

  it("renders an idle button with its label", () => {
    const html = renderWithProviders(<AsyncButton onClick={async () => {}}>刷新模型</AsyncButton>);
    expect(html).toContain('data-async-state="idle"');
    expect(html).toContain("刷新模型");
  });

  it("wraps disabled buttons in a focusable reason trigger", () => {
    const html = renderWithProviders(
      <AsyncButton onClick={async () => {}} disabled disabledReason="请先登录">
        保存
      </AsyncButton>,
    );
    expect(html).toContain('data-slot="disabled-reason-trigger"');
    expect(html).toContain('tabindex="0"');
  });

  it("labels icon-only buttons for assistive technology", () => {
    const html = renderWithProviders(
      <IconButton label="展开全部工具输出" shortcut="Ctrl+O">
        <svg />
      </IconButton>,
    );
    expect(html).toContain('aria-label="展开全部工具输出"');
    expect(html).toContain('data-size="icon"');
  });
});

describe("InlineEdit", () => {
  it("shows the value outside editing mode", () => {
    const html = renderWithProviders(<InlineEdit value="会话 A" onCommit={() => {}} />);
    expect(html).toContain('data-slot="inline-edit-display"');
    expect(html).toContain("会话 A");
  });

  it("renders an input with the current value in editing mode", () => {
    const html = renderWithProviders(
      <InlineEdit value="会话 A" editing onCommit={() => {}} aria-label="重命名" />,
    );
    expect(html).toContain("<input");
    expect(html).toContain('value="会话 A"');
  });
});

describe("setting fields", () => {
  it("renders section, instant switch and collapsed advanced group", () => {
    const html = renderWithProviders(
      <SettingSection title="对话">
        <SettingSwitchField label="自动压缩" value onCommit={async () => {}} />
        <SettingAdvancedGroup>
          <SettingTextField label="别名" value="x" onCommit={async () => {}} />
        </SettingAdvancedGroup>
      </SettingSection>,
    );
    expect(html).toContain("自动压缩");
    expect(html).toContain('role="switch"');
    expect(html).toContain("高级");
    expect(html).not.toContain("别名");
  });

  it("shows unit suffix and reset-to-default only when the value differs", () => {
    const changed = renderWithProviders(
      <SettingNumberField
        label="超时"
        unit="s"
        value={45}
        defaultValue={30}
        onCommit={async () => {}}
      />,
    );
    expect(changed).toContain(">s<");
    expect(changed).toContain("恢复默认");
    const unchanged = renderWithProviders(
      <SettingNumberField
        label="超时"
        unit="s"
        value={30}
        defaultValue={30}
        onCommit={async () => {}}
      />,
    );
    expect(unchanged).not.toContain("恢复默认");
  });
});

describe("createUndoGate", () => {
  it("settles exactly once: undo wins before expiry", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    const gate = createUndoGate(onUndo, onExpire);
    expect(gate.undo()).toBe(true);
    expect(gate.undo()).toBe(false);
    expect(gate.expire()).toBe(false);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("expires once when not undone", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    const gate = createUndoGate(onUndo, onExpire);
    expect(gate.expire()).toBe(true);
    expect(gate.undo()).toBe(false);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });
});
