// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { ProviderFormDialog } from "./ProviderFormDialog.js";
import { RenameProviderDialog } from "./ProviderIdDialogs.js";

beforeEach(installDomPolyfills);
afterEach(cleanup);

it("NM-1 adds CPA without replacing it with the generated slug and explains an invalid slash", async () => {
  const { wrapper } = createNekTestEnv();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <ProviderFormDialog open existingIds={new Set()} onOpenChange={() => {}} onSave={onSave} />,
    { wrapper },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "Company Proxy" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
    target: { value: "https://proxy.example.test/v1" },
  });
  const id = screen.getByRole("textbox", { name: "ID" });
  expect((id as HTMLInputElement).value).toBe("company-proxy");
  fireEvent.change(id, { target: { value: "CPA/vendor" } });
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(/分隔服务商 ID 和模型 ID/u)).toBeTruthy();
  const save = screen.getByRole("button", { name: "添加服务商" });
  fireEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(id, { target: { value: "CPA" } });
  fireEvent.click(save);
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "CPA" })));
});

it("NM-2 blocks another provider's case-folded ID but submits a case-only rename", async () => {
  const { wrapper, config } = createNekTestEnv();
  const provider = (await config.readModelsConfig({ kind: "local" })).providers[0]!;
  const onRename = vi.fn().mockResolvedValue(undefined);
  render(
    <RenameProviderDialog
      open
      provider={{ ...provider, id: "cpa" }}
      existingIds={new Set(["cpa", "My_Proxy"])}
      onOpenChange={() => {}}
      onRename={onRename}
    />,
    { wrapper },
  );
  const id = screen.getByRole("textbox", { name: "新 ID" });
  const save = screen.getByRole("button", { name: "修改 ID" });
  fireEvent.change(id, { target: { value: "my_proxy" } });
  expect(screen.getByText(/模型引用不区分大小写/u)).toBeTruthy();
  fireEvent.click(save);
  expect(onRename).not.toHaveBeenCalled();
  fireEvent.change(id, { target: { value: "CPA" } });
  fireEvent.click(save);
  await waitFor(() => expect(onRename).toHaveBeenCalledExactlyOnceWith("CPA"));
});
