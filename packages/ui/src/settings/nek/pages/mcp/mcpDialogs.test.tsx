// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { McpImportDialog } from "./McpImportDialog.js";
import { McpServerFormDialog } from "./McpServerFormDialog.js";

beforeEach(installDomPolyfills);
afterEach(cleanup);

it("NM-5 create form rejects dots and untrimmed invalid names and keeps a valid name unchanged", async () => {
  const { wrapper } = createNekTestEnv();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <McpServerFormDialog open onOpenChange={() => {}} existingNames={new Set()} onSave={onSave} />,
    { wrapper },
  );
  const name = screen.getByLabelText("名称");
  fireEvent.change(screen.getByLabelText("命令"), { target: { value: "node" } });
  const submit = screen.getByRole("button", { name: "添加服务器" });
  for (const value of ["Vendor.AI", " Vendor_AI", "Vendor_AI "]) {
    fireEvent.change(name, { target: { value } });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/名称只能包含英文字母、数字、下划线和连字符/u)).toBeTruthy();
    fireEvent.click(submit);
    expect(onSave).not.toHaveBeenCalled();
  }
  fireEvent.change(name, { target: { value: "Vendor_AI-2" } });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Vendor_AI-2", { command: "node" }),
  );
});

it("NM-5 import conflict rename uses SERVER_NAME and reports errors next to the new name", async () => {
  const { wrapper } = createNekTestEnv();
  const onImport = vi.fn().mockResolvedValue(undefined);
  render(
    <McpImportDialog
      open
      onOpenChange={() => {}}
      existingNames={new Set(["filesystem"])}
      onImport={onImport}
    />,
    { wrapper },
  );
  fireEvent.change(screen.getByLabelText("MCP 配置 JSON"), {
    target: { value: JSON.stringify({ mcpServers: { filesystem: { command: "node" } } }) },
  });
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  fireEvent.click(await screen.findByRole("radio", { name: "重命名" }));
  const next = screen.getByLabelText("新名称");
  fireEvent.change(next, { target: { value: "fs.new" } });
  expect(next.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(/名称只能包含英文字母、数字、下划线和连字符/u)).toBeTruthy();
  expect(onImport).not.toHaveBeenCalled();
  fireEvent.change(next, { target: { value: "FS_new-2" } });
  fireEvent.click(screen.getByRole("button", { name: "导入 1 个服务器" }));
  await waitFor(() =>
    expect(onImport).toHaveBeenCalledExactlyOnceWith([
      { name: "FS_new-2", config: { command: "node" }, overwrite: false },
    ]),
  );
});
