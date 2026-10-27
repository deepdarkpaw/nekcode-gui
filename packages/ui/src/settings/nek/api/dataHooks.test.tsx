// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useNekSettingsDoc } from "./settingsDocs.js";
import { useNekModelsDoc } from "./modelsDoc.js";
import { useNekDirtyRegistration } from "./useNekDocument.js";
import { useNekTarget } from "./NekSettingsContext.js";
import { useNekLogin } from "./useNekLogin.js";
import { useNekQuery } from "./useNekQuery.js";
import { useNekAgentPresetsDoc } from "./mcpDocs.js";
import { useNekReloadNotifications } from "./useNekReloadNotifications.js";
import {
  createNekTestEnv,
  flushNek,
  installDomPolyfills,
  type NekTestEnv,
} from "../test/nekTestUtils.js";
import {
  MOCK_PROJECT_CWD,
  MOCK_REMOTE_CONNECTED,
  MOCK_REMOTE_DISCONNECTED,
} from "./mock/mockSeed.js";
import { NekConfigApiError } from "./nekErrors.js";

const LOCAL = { kind: "local" } as const;

let env: NekTestEnv;

beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
});

afterEach(() => cleanup());

function renderSettings(dirty = false) {
  return renderHook(
    () => {
      const doc = useNekSettingsDoc("global");
      useNekDirtyRegistration([doc], dirty);
      return doc;
    },
    { wrapper: env.wrapper },
  );
}

describe("useNekSettingsDoc", () => {
  it("loads and applies optimistic patches", async () => {
    env = createNekTestEnv({ latencyMs: 30 });
    const { result } = renderSettings();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.values.defaultModel).toBe("deepseek-chat");

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.patch({ httpProxy: "http://127.0.0.1:7890" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // 乐观：写入完成前就显示新值。
    expect(result.current.data?.values.httpProxy).toBe("http://127.0.0.1:7890");
    await act(() => pending);
    expect(env.config.machines.get("local")?.settings.value.httpProxy).toBe(
      "http://127.0.0.1:7890",
    );
  });

  it("rolls back and rethrows on failure", async () => {
    const { result } = renderSettings();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    env.config.failNext("patchSettings", { code: "io", message: "EACCES: permission denied" });
    let caught: unknown;
    await act(async () => {
      await result.current.patch({ httpProxy: "x" }).catch((error: unknown) => {
        caught = error;
      });
    });
    expect(caught).toBeInstanceOf(NekConfigApiError);
    expect((caught as Error).message).toBe("EACCES: permission denied");
    expect(result.current.data?.values.httpProxy).toBeUndefined();
    expect(result.current.banner).toBeNull();
  });

  it("shows a conflict banner and replays the write on 'keep mine'", async () => {
    const { result } = renderSettings();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    env.config.simulateExternalEdit(LOCAL, "settings", (value: { shellPath?: string }) => ({
      ...value,
      shellPath: "/bin/zsh",
    }));
    await act(async () => {
      await result.current.patch({ httpProxy: "mine" }).catch(() => undefined);
    });
    expect(result.current.banner).toEqual({ kind: "conflict" });
    expect(result.current.data?.values.httpProxy).toBeUndefined();

    await act(() => result.current.resolveBanner("keep"));
    await flushNek();
    expect(result.current.banner).toBeNull();
    expect(result.current.data?.values).toMatchObject({ httpProxy: "mine", shellPath: "/bin/zsh" });
  });

  it("discards the write and resets drafts on 'reload'", async () => {
    const { result } = renderSettings();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    env.config.simulateExternalEdit(LOCAL, "settings", (value: object) => ({
      ...value,
      shellPath: "/bin/fish",
    }));
    await act(async () => {
      await result.current.patch({ httpProxy: "mine" }).catch(() => undefined);
    });
    const token = result.current.resetToken;
    await act(() => result.current.resolveBanner("reload"));
    expect(result.current.resetToken).toBe(token + 1);
    expect(result.current.data?.values.httpProxy).toBeUndefined();
    expect(result.current.data?.values.shellPath).toBe("/bin/fish");
  });

  it("silently refreshes on external change without unsaved edits", async () => {
    const { result } = renderSettings(false);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    env.config.simulateExternalEdit(LOCAL, "settings", (value: object) => ({
      ...value,
      shellPath: "/bin/bash",
    }));
    await flushNek();
    expect(result.current.data?.values.shellPath).toBe("/bin/bash");
    expect(result.current.banner).toBeNull();
  });

  it("shows the external-change banner when a form has unsaved edits", async () => {
    const { result } = renderSettings(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    env.config.simulateExternalEdit(LOCAL, "settings", (value: object) => ({
      ...value,
      shellPath: "/bin/bash",
    }));
    await flushNek();
    expect(result.current.banner).toEqual({ kind: "external" });
    expect(result.current.data?.values.shellPath).toBeUndefined();
    await act(() => result.current.resolveBanner("keep"));
    expect(result.current.data?.values.shellPath).toBe("/bin/bash");
  });

  it("ignores watch echoes of its own writes", async () => {
    const { result } = renderSettings(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(() => result.current.patch({ shellPath: "/bin/sh" }));
    await flushNek();
    expect(result.current.banner).toBeNull();
  });
});

describe("config target", () => {
  it("reloads every document when switching to a connected remote", async () => {
    const { result } = renderHook(() => ({ doc: useNekModelsDoc(), target: useNekTarget() }), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    expect(result.current.doc.data?.providers.map((p) => p.id)).toContain("deepseek");
    act(() =>
      result.current.target.setTarget({ kind: "remote", connectionId: MOCK_REMOTE_CONNECTED }),
    );
    await waitFor(() =>
      expect(result.current.doc.data?.providers.map((p) => p.id)).toEqual(["openrouter"]),
    );
    expect(result.current.target.targetInfo?.label).toBe("dev-box");
  });

  it("does not load from a disconnected remote", async () => {
    const { result } = renderHook(() => ({ doc: useNekModelsDoc(), target: useNekTarget() }), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    act(() =>
      result.current.target.setTarget({ kind: "remote", connectionId: MOCK_REMOTE_DISCONNECTED }),
    );
    await waitFor(() => expect(result.current.doc.status).toBe("disconnected"));
    expect(result.current.doc.data).toBeUndefined();
  });
});

describe("models document", () => {
  it("reorders and deletes models optimistically", async () => {
    const { result } = renderHook(() => useNekModelsDoc(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(() =>
      result.current.reorderModels("deepseek", ["deepseek-reasoner", "deepseek-chat"]),
    );
    expect(env.config.machines.get("local")?.models.value[0]?.models.map((m) => m.id)).toEqual([
      "deepseek-reasoner",
      "deepseek-chat",
    ]);
    await act(() => result.current.deleteModel("deepseek", "deepseek-chat"));
    expect(result.current.data?.providers[0]?.models.map((m) => m.id)).toEqual([
      "deepseek-reasoner",
    ]);
  });

  it("renames a provider and updates references in settings", async () => {
    const { result } = renderHook(
      () => ({ models: useNekModelsDoc(), settings: useNekSettingsDoc() }),
      {
        wrapper: env.wrapper,
      },
    );
    await waitFor(() => expect(result.current.settings.status).toBe("ready"));
    await waitFor(() => expect(result.current.models.status).toBe("ready"));
    await act(() => result.current.models.renameProvider("deepseek", "ds"));
    await flushNek();
    expect(result.current.settings.data?.values.defaultProvider).toBe("ds");
    expect(result.current.settings.data?.values.enabledModels).toContain("ds/deepseek-chat");
  });
});

describe("useNekQuery", () => {
  it("refreshes after writes", async () => {
    const { result } = renderHook(
      () => ({
        models: useNekModelsDoc(),
        available: useNekQuery((api, target) => api.listAvailableModels(target), []),
      }),
      { wrapper: env.wrapper },
    );
    await waitFor(() => expect(result.current.available.status).toBe("ready"));
    await waitFor(() => expect(result.current.models.status).toBe("ready"));
    await act(() => result.current.models.addModels("local-ollama", [{ id: "llama3" }]));
    await waitFor(() =>
      expect(result.current.available.data?.some((model) => model.id === "llama3")).toBe(true),
    );
  });
});

describe("useNekLogin", () => {
  it("walks through auth_url + manual code to done", async () => {
    const { result } = renderHook(() => useNekLogin(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    await act(() => result.current.start("anthropic"));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ phase: "active", prompt: expect.anything() }),
    );
    const state = result.current.state;
    expect(state.phase === "active" && state.authUrl?.url).toContain("https://");
    await act(() => result.current.answer("good-code#state"));
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
  });

  it("shows the device code for Codex and reports failures", async () => {
    const { result } = renderHook(() => useNekLogin(), { wrapper: env.wrapper });
    await act(() => result.current.start("openai-codex"));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "active",
        deviceCode: { userCode: "NEK-4821" },
      }),
    );
    await waitFor(() => expect(result.current.state).toMatchObject({ prompt: expect.anything() }));
    await act(() => result.current.answer("bad-code"));
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
  });

  it("cancels an active login", async () => {
    const { result } = renderHook(() => useNekLogin(), { wrapper: env.wrapper });
    await act(() => result.current.start("anthropic"));
    await act(() => result.current.cancel());
    expect(result.current.state.phase).toBe("idle");
  });
});

describe("v2 contract wiring", () => {
  it("passes the project cwd to readModelsConfig and renameProvider", async () => {
    const calls: Array<string | undefined> = [];
    const read = env.config.readModelsConfig.bind(env.config);
    env.config.readModelsConfig = (target, cwd) => {
      calls.push(cwd);
      return read(target, cwd);
    };
    const renames: Array<string | undefined> = [];
    const rename = env.config.renameProvider.bind(env.config);
    env.config.renameProvider = (target, from, to, options) => {
      renames.push(options.cwd);
      return rename(target, from, to, options);
    };
    const { result } = renderHook(() => useNekModelsDoc(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls).toEqual([MOCK_PROJECT_CWD]);
    await act(() => result.current.renameProvider("deepseek", "ds"));
    expect(renames).toEqual([MOCK_PROJECT_CWD]);
  });

  it("exposes preset diagnostics and reloads on a project preset change", async () => {
    const { result } = renderHook(() => useNekAgentPresetsDoc(MOCK_PROJECT_CWD), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data?.entries.map((entry) => entry.preset.name)).toContain("reviewer");
    expect(result.current.data?.diagnostics).toMatchObject([
      { severity: "error", message: expect.stringContaining("unknown thinking level") },
    ]);
    const before = result.current.data?.revision;

    // 项目级 agents/*.md 变化：按 scope + 文件名匹配，文档重新读取。
    act(() => env.config.simulatePresetEdit(LOCAL, "docs-writer"));
    await flushNek();
    expect(result.current.data?.revision).not.toBe(before);
  });

  it("toasts a reload failure after a write and offers a retry", async () => {
    function Notifier() {
      useNekReloadNotifications();
      return null;
    }
    render(<Notifier />, { wrapper: env.wrapper });
    await act(async () => {
      env.config.simulateReloadResult(LOCAL, {
        failures: [{ sessionKey: "session-7", message: "stdin closed" }],
      });
    });
    expect(await screen.findByText(/stdin closed/)).toBeDefined();
    const retry = await screen.findByRole("button", { name: "重试" });
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(await screen.findByText("所有 nek 进程已重新载入")).toBeDefined();
  });
});
