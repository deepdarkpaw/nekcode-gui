// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createNekTestEnv,
  flushNek,
  installDomPolyfills,
  type NekTestEnv,
} from "../test/nekTestUtils.js";
import { ProvidersPage } from "./providers/ProvidersPage.js";
import { ToolsPage } from "./ToolsPage.js";
import { McpPage } from "./mcp/McpPage.js";
import { AccountsPage } from "./accounts/AccountsPage.js";

let env: NekTestEnv;
const LOCAL = { kind: "local" } as const;

beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
});
afterEach(() => cleanup());

async function selectProvider(name: RegExp) {
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("ProvidersPage", () => {
  it("lists providers and shows the model table of the selection", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    const list = await screen.findByRole("listbox", { name: "服务商" });
    expect(within(list).getAllByRole("option").length).toBe(5);
    expect(screen.getByText("deepseek-reasoner")).toBeDefined();
    expect(screen.getByText("模型（2）")).toBeDefined();
  });

  it("deletes a model with a 5 s undo toast that restores it in place", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByTitle("deepseek-chat");
    const deleteButtons = screen.getAllByRole("button", { name: "删除模型" });
    await act(async () => {
      fireEvent.click(deleteButtons[0]!);
    });
    await waitFor(() => expect(screen.queryByTitle("deepseek-chat")).toBeNull());
    const undo = await screen.findByRole("button", { name: "撤销" });
    await act(async () => {
      fireEvent.click(undo);
    });
    await flushNek(5);
    expect(
      env.config.machines.get("local")?.models.value[0]?.models.map((model) => model.id),
    ).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("fetches models: already-added rows are locked, the primary button counts selections", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByTitle("deepseek-chat");
    fireEvent.click(screen.getAllByRole("button", { name: "获取模型列表" })[0]!);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("gpt-4.1");
    const added = within(dialog).getAllByText("已添加");
    expect(added.length).toBe(2);
    const addButton = within(dialog).getByRole("button", { name: "添加 0 个模型" });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "全选" }));
    const confirm = await within(dialog).findByRole("button", { name: "添加 4 个模型" });
    expect(within(dialog).getAllByText("内置目录").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("默认值").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(env.config.machines.get("local")?.models.value[0]?.models.length).toBe(6),
    );
  });

  it("maps 401 and 404 to actionable messages", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await selectProvider(/Broken Key/);
    fireEvent.click((await screen.findAllByRole("button", { name: "获取模型列表" }))[0]!);
    expect(await screen.findByText("Key 无效或无权限")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await selectProvider(/No Model List/);
    fireEvent.click((await screen.findAllByRole("button", { name: "获取模型列表" }))[0]!);
    expect(await screen.findByText("该地址不提供模型列表接口")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    expect(await screen.findByRole("dialog", { name: "添加模型" })).toBeDefined();
  });

  it("shows the external-change banner while a form has unsaved edits", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByTitle("deepseek-chat");
    fireEvent.click(screen.getByRole("button", { name: "编辑服务商" }));
    const nameInput = await screen.findByLabelText(/名称/);
    fireEvent.change(nameInput, { target: { value: "DeepSeek CN" } });
    act(() => {
      env.config.simulateExternalEdit(LOCAL, "models");
    });
    await flushNek();
    expect(await screen.findByText("配置已在外部修改")).toBeDefined();
    expect(screen.getByRole("button", { name: "保留我的修改" })).toBeDefined();
    expect((nameInput as HTMLInputElement).value).toBe("DeepSeek CN");
  });
});

describe("ToolsPage", () => {
  it("shows Tavily defaults and persists the provider together with a key", async () => {
    render(<ToolsPage />, { wrapper: env.wrapper });
    expect((await screen.findByLabelText("搜索服务商")).textContent).toContain("Tavily");
    expect((screen.getByLabelText("结果数") as HTMLInputElement).value).toBe("8");
    const key = screen.getByLabelText("搜索 API Key");
    fireEvent.change(key, { target: { value: "$TAVILY_API_KEY" } });
    await act(async () => { fireEvent.blur(key); });
    await waitFor(() => expect(env.config.machines.get("local")?.settings.value.webSearch).toMatchObject({ provider: "tavily", apiKey: "$TAVILY_API_KEY" }));
  });

  it("switches to Exa without inventing a shared endpoint or moving credentials", async () => {
    render(<ToolsPage />, { wrapper: env.wrapper });
    const provider = await screen.findByLabelText("搜索服务商");
    fireEvent.keyDown(provider, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Exa" }));
    await waitFor(() => expect(env.config.machines.get("local")?.settings.value.webSearch?.provider).toBe("exa"));
    expect(env.config.machines.get("local")?.settings.value.webSearch?.endpoint).toBeUndefined();
    expect(screen.getByText("Exa 可不填密钥；可用额度由 Exa 服务决定。")).toBeTruthy();
  });

  it("does not send a configured Tavily key to Exa on a provider switch", async () => {
    env.config.machines.get("local")!.settings.value.webSearch = { provider: "tavily", apiKey: "$TAVILY_API_KEY" };
    render(<ToolsPage />, { wrapper: env.wrapper });
    const provider = await screen.findByLabelText("搜索服务商");
    fireEvent.keyDown(provider, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Exa" }));
    await screen.findAllByText(/请先清空 API Key/);
    expect(env.config.machines.get("local")?.settings.value.webSearch).toEqual({ provider: "tavily", apiKey: "$TAVILY_API_KEY" });
  });

  it("requires an explicit provider for ambiguous existing keys rather than guessing", async () => {
    env.config.machines.get("local")!.settings.value.webSearch = { apiKey: "$SEARCH_API_KEY" };
    render(<ToolsPage />, { wrapper: env.wrapper });
    const provider = await screen.findByLabelText("搜索服务商");
    expect((screen.getByRole("button", { name: "测试搜索" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(provider, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Exa" }));
    await waitFor(() => expect(env.config.machines.get("local")?.settings.value.webSearch).toEqual({ provider: "exa", apiKey: "$SEARCH_API_KEY" }));
  });

  it("writes +/- deltas and rolls back a switch when saving fails", async () => {
    render(<ToolsPage />, { wrapper: env.wrapper });
    const webSwitch = await screen.findByRole("switch", { name: "启用联网搜索" });
    expect(webSwitch.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(webSwitch);
    });
    await waitFor(() =>
      expect(env.config.machines.get("local")?.settings.value.defaultTools).toEqual([
        "-web_search",
      ]),
    );

    env.config.failNext("patchSettings", { code: "io", message: "EACCES: settings.json" });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "启用联网搜索" }));
    });
    await waitFor(() =>
      expect(screen.getAllByText("EACCES: settings.json").length).toBeGreaterThan(0),
    );
    expect(screen.getByRole("switch", { name: "启用联网搜索" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("McpPage", () => {
  it("imports pasted JSON with per-item conflict resolution", async () => {
    render(<McpPage />, { wrapper: env.wrapper });
    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: "粘贴 JSON 导入" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("MCP 配置 JSON"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            filesystem: { command: "fs2" },
            linear: { url: "https://mcp.linear.app/sse" },
          },
        }),
      },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "预览" }));
    });
    expect(await within(dialog).findByText("已存在同名服务器")).toBeDefined();
    // 默认跳过冲突项：只导入 1 个。
    const confirm = within(dialog).getByRole("button", { name: "导入 1 个服务器" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "重命名" }));
    expect(await within(dialog).findByRole("button", { name: "导入 2 个服务器" })).toBeDefined();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "导入 2 个服务器" }));
    });
    await waitFor(() =>
      expect(Object.keys(env.config.machines.get("local")?.mcp.value ?? {})).toContain(
        "filesystem-2",
      ),
    );
    expect(env.config.machines.get("local")?.mcp.value.linear).toBeDefined();
    void confirm;
  });
});

describe("AccountsPage", () => {
  it("shows login state and asks before signing out", async () => {
    render(<AccountsPage />, { wrapper: env.wrapper });
    expect(await screen.findByText(/已登录/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const confirm = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "退出登录" }));
    });
    await waitFor(() =>
      expect(env.config.machines.get("local")?.auth.get("anthropic")?.kind).toBe("none"),
    );
  });
});

describe("ToolsPage v2", () => {
  it("lists the tools the host reports, including powershell being off by default", async () => {
    render(<ToolsPage />, { wrapper: env.wrapper });
    const powershell = await screen.findByText("powershell");
    const row = powershell.closest("label");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("默认关闭");
    // 默认工具集来自工具清单的 defaultActive：未设置 defaultTools 时默认工具应为勾选
    const read = screen.getByText("read").closest("label")!;
    expect(within(read).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(within(row!).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    // 旧硬编码列表里的 todo_write 不再出现
    expect(screen.queryByText("todo_write")).toBeNull();
    await act(async () => {
      fireEvent.click(within(row!).getByRole("checkbox"));
    });
    await waitFor(() =>
      expect(env.config.machines.get("local")?.settings.value.defaultTools).toEqual([
        "+powershell",
      ]),
    );
  });
});

describe("McpPage v2", () => {
  it("shows the file each entry comes from", async () => {
    render(<McpPage />, { wrapper: env.wrapper });
    await screen.findByText("filesystem");
    expect(
      screen.getAllByText(`来源：${env.config.machines.get("local")!.mcp.path}`).length,
    ).toBeGreaterThan(0);
  });
});

describe("AccountsPage v2", () => {
  it("asks for a new sign-in when the token refresh failed", async () => {
    const machine = env.config.machines.get("local")!;
    machine.auth.set("anthropic", { ...machine.auth.get("anthropic")!, state: "refresh_failed" });
    render(<AccountsPage />, { wrapper: env.wrapper });
    expect(await screen.findByText(/刷新令牌失败/)).toBeDefined();
    expect(screen.getByText(/需要重新登录/)).toBeDefined();
  });
});

describe("ProviderFormDialog v2", () => {
  it("clears a saved key with { remove: true } instead of an empty string", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByTitle("deepseek-chat");
    fireEvent.click(screen.getByRole("button", { name: "编辑服务商" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "清除密钥" }));
    expect(await within(dialog).findByText("保存后将删除已保存的密钥")).toBeDefined();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "保存服务商" }));
    });
    await waitFor(() =>
      expect(
        env.config.machines.get("local")?.models.value.find((item) => item.id === "deepseek")
          ?.apiKey,
      ).toBeUndefined(),
    );
  });

  it("tests the edited configuration with the saved key", async () => {
    render(<ProvidersPage />, { wrapper: env.wrapper });
    await screen.findByTitle("deepseek-chat");
    fireEvent.click(screen.getByRole("button", { name: "编辑服务商" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText(/Base URL/), {
      target: { value: "https://api.deepseek.com/v2" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "测试修改后的配置" }));
    });
    expect(await within(dialog).findByText(/连接正常/)).toBeDefined();
  });
});

describe("target switcher", () => {
  it("shows the machine host name next to the target", async () => {
    render(<ToolsPage />, { wrapper: env.wrapper });
    await screen.findByRole("switch", { name: "启用联网搜索" });
    const trigger = await screen.findByRole("button", { name: /配置目标：/ });
    expect(trigger.textContent).toContain("DESKTOP-NEK");
  });
});
