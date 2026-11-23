// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NekMcpServerConfig } from "@zcode/shared/nek-protocol";
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
  const name = screen.getByRole("textbox", { name: "名称" });
  fireEvent.change(screen.getByRole("textbox", { name: "命令" }), { target: { value: "node" } });
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

it("NM-6 editing the description leaves aliases and unedited OAuth settings untouched", async () => {
  const { wrapper } = createNekTestEnv();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const config = {
    type: "streamable-http",
    url: "https://example.test/mcp",
    exposure: "codemode",
    toolExposure: { lookup: "codemode-deferred" },
    enabled: true,
    oauth: {
      callbackUrl: "http://localhost:3030/callback",
      callbackPort: 3030,
      clientName: "existing",
      future: true,
    },
  } as const;
  render(
    <McpServerFormDialog
      open
      initial={{ name: "Legacy", config }}
      onOpenChange={() => {}}
      existingNames={new Set(["Legacy"])}
      onSave={onSave}
    />,
    { wrapper },
  );
  fireEvent.change(screen.getByLabelText("描述"), { target: { value: "新的说明" } });
  fireEvent.click(screen.getByRole("button", { name: "保存服务器" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Legacy", {
      ...config,
      description: "新的说明",
    }),
  );
});

it("NM-7 puts the URL, timeout and OAuth errors next to their actual fields and blocks submit", async () => {
  const { wrapper } = createNekTestEnv();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <McpServerFormDialog open onOpenChange={() => {}} existingNames={new Set()} onSave={onSave} />,
    { wrapper },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "docs" } });
  fireEvent.click(screen.getByRole("radio", { name: "HTTP" }));
  const url = screen.getByRole("textbox", { name: "URL" });
  const change = (field: HTMLElement, value: string) =>
    fireEvent.change(field, { target: { value } });
  change(url, "ftp://example.test/mcp");
  fireEvent.click(screen.getByRole("button", { name: "高级" }));
  const timeout = screen.getByLabelText("超时");
  const port = screen.getByLabelText("回调端口");
  const redirect = screen.getByLabelText("回调 URL");
  const metadata = screen.getByLabelText("授权服务器元数据 URL");
  change(timeout, "0");
  change(port, "65536");
  change(redirect, "https://outside.example.test/callback");
  change(metadata, "http://outside.example.test/metadata");
  const submit = screen.getByRole("button", { name: "添加服务器" });
  fireEvent.click(submit);
  expect(onSave).not.toHaveBeenCalled();
  for (const [field, message] of [
    [url, "有效的 HTTP 或 HTTPS"],
    [timeout, "大于 0"],
    [port, "1 到 65535"],
    [redirect, "不能有查询参数或片段"],
    [metadata, "必须使用 HTTPS"],
  ] as const) {
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toContain(
      message,
    );
  }
  change(url, "https://example.test/mcp");
  change(timeout, "0.25");
  change(port, "3030");
  change(redirect, "http://127.0.0.1:3031/callback");
  expect(screen.getByText(/端口与回调端口不一致/u)).toBeTruthy();
  change(port, "3031");
  change(metadata, "http://localhost/metadata");
  fireEvent.click(submit);
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith("docs", {
      type: "http",
      url: "https://example.test/mcp",
      timeout: 0.25,
      oauth: {
        callbackPort: 3031,
        callbackUrl: "http://127.0.0.1:3031/callback",
        authServerMetadataUrl: "http://localhost/metadata",
      },
    }),
  );
});

it("NM-7 reports legacy SSE and deprecated auth where the user can correct them", async () => {
  const { wrapper } = createNekTestEnv();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const bad = { type: "sse", url: "https://example.test/mcp" } as unknown as NekMcpServerConfig;
  render(
    <McpServerFormDialog
      open
      initial={{ name: "Legacy", config: bad }}
      onOpenChange={() => {}}
      existingNames={new Set()}
      onSave={onSave}
    />,
    { wrapper },
  );
  expect(screen.getByText(/不支持旧版 SSE 传输/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "HTTP" }));
  fireEvent.click(screen.getByRole("button", { name: "保存服务器" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Legacy", { ...bad, type: "http" }),
  );
  cleanup();

  render(
    <McpImportDialog open onOpenChange={() => {}} existingNames={new Set()} onImport={vi.fn()} />,
    { wrapper },
  );
  const json = screen.getByLabelText("MCP 配置 JSON");
  fireEvent.change(json, {
    target: {
      value: JSON.stringify({
        mcpServers: {
          stale: bad,
          unsupported: { url: "https://example.test/mcp", auth: { provider: "test" } },
        },
      }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  await waitFor(() => expect(json.getAttribute("aria-invalid")).toBe("true"));
  const reason = document.getElementById(json.getAttribute("aria-describedby")!)?.textContent;
  expect(reason).toContain("legacy SSE transport is not supported; use the streamable HTTP URL");
  expect(reason).toContain("auth.provider is not supported; use OAuth or an Authorization header");
  expect(reason).not.toMatch(/expected|Invalid input/u);
});
