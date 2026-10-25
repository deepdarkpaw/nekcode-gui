// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Input } from "@/components/ui/input.js";
import { createNekTestEnv, installDomPolyfills } from "../test/nekTestUtils.js";
import { NekConfirmDialog } from "./NekConfirmDialog.js";
import { NekFormDialog } from "./NekFormDialog.js";

beforeEach(() => installDomPolyfills());
afterEach(() => cleanup());

function FormHarness({ onSave }: { onSave: (value: string) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState("");
  const [other, setOther] = useState("");
  const valid = value.trim() !== "";
  return (
    <NekFormDialog
      open={open}
      onOpenChange={setOpen}
      title="表单"
      dirty={value !== "" || other !== ""}
      valid={valid}
      saveLabel="保存服务商"
      onSave={() => onSave(value)}
    >
      {({ attempted }) => (
        <>
          <Input
            aria-label="other"
            value={other}
            onChange={(event) => setOther(event.target.value)}
          />
          <Input
            aria-label="name"
            required
            aria-invalid={attempted && !valid ? true : undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </>
      )}
    </NekFormDialog>
  );
}

describe("NekFormDialog", () => {
  it("focuses the first empty required field on open", async () => {
    const env = createNekTestEnv();
    render(<FormHarness onSave={async () => undefined} />, { wrapper: env.wrapper });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("name")));
  });

  it("keeps the primary button clickable when invalid and focuses the first invalid field", async () => {
    const env = createNekTestEnv();
    const onSave = vi.fn(async () => undefined);
    render(<FormHarness onSave={onSave} />, { wrapper: env.wrapper });
    const primary = screen.getByRole("button", { name: "保存服务商" });
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    screen.getByLabelText("other").focus();
    await act(async () => {
      fireEvent.click(primary);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("name").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("name"));
  });

  it("does not submit on Enter while an IME composition is active", async () => {
    const env = createNekTestEnv();
    const onSave = vi.fn(async () => undefined);
    render(<FormHarness onSave={onSave} />, { wrapper: env.wrapper });
    const input = screen.getByLabelText("name");
    fireEvent.change(input, { target: { value: "deepseek" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存服务商" }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("deepseek"));
  });

  it("asks before discarding unsaved changes", async () => {
    const env = createNekTestEnv();
    render(<FormHarness onSave={async () => undefined} />, { wrapper: env.wrapper });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("放弃未保存的修改");
    // 确认框默认焦点在安全选项上。
    await waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    expect(screen.getByLabelText("name")).toBeDefined();
  });
});

describe("NekConfirmDialog", () => {
  it("puts the destructive action on the left and focuses cancel", async () => {
    const env = createNekTestEnv();
    const onConfirm = vi.fn(async () => undefined);
    render(
      <NekConfirmDialog
        open
        onOpenChange={() => undefined}
        title="删除服务商 x？"
        confirmLabel="删除服务商"
        destructive
        onConfirm={onConfirm}
      />,
      { wrapper: env.wrapper },
    );
    const dialog = await screen.findByRole("alertdialog");
    const buttons = Array.from(dialog.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    expect(buttons).toEqual(["删除服务商", "取消"]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除服务商" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows the failure reason in place and stays open", async () => {
    const env = createNekTestEnv();
    render(
      <NekConfirmDialog
        open
        onOpenChange={() => undefined}
        title="t"
        confirmLabel="退出登录"
        destructive
        onConfirm={async () => Promise.reject(new Error("EACCES"))}
      />,
      { wrapper: env.wrapper },
    );
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("EACCES"));
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});
