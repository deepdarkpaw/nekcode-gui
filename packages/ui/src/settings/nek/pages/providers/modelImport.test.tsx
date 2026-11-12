// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NekCatalogModel, NekProviderView } from "@zcode/shared/nek-protocol";
import { createNekTestEnv, installDomPolyfills, type NekTestEnv } from "../../test/nekTestUtils.js";
import { FetchModelsDialog } from "./FetchModelsDialog.js";
import { ModelEditorDialog } from "./ModelEditorDialog.js";
import { modelConfigFromDraft } from "./modelDraft.js";

const provider: NekProviderView = {
  id: "CPA",
  name: "CPA",
  api: "",
  baseUrl: "https://gateway.invalid/v1",
  apiKey: { kind: "none" },
  overridesBuiltin: false,
  models: [{ id: "old", api: "anthropic-messages" }],
};
let env: NekTestEnv;
beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
  vi.spyOn(env.config, "fetchProviderModels").mockResolvedValue({
    ok: true,
    endpoint: "https://gateway.invalid/v1/models",
    models: [{ id: "gemini-4-carbon" }],
  });
  vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([
    {
      provider: "google",
      id: "gemini-4-carbon",
      api: "google-generative-ai",
      name: "Gemini",
      input: ["text"],
      contextWindow: 800000,
      maxTokens: 120000,
      reasoning: false,
      thinkingLevels: [],
    } as NekCatalogModel,
  ]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function chooseModel() {
  const list = await screen.findByRole("list", { name: "可添加的模型" });
  fireEvent.click(within(list).getByRole("checkbox"));
}

describe("explicit endpoint import", () => {
  it("requires a choice for a custom mixed gateway even when the catalog knows the id", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <FetchModelsDialog
        open
        provider={provider}
        onOpenChange={() => {}}
        onAdd={onAdd}
        onManualAdd={() => {}}
      />,
      { wrapper: env.wrapper },
    );
    await chooseModel();
    const add = screen.getByRole("button", { name: "添加 1 个模型" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI Responses" }));
    const enabledAdd = screen.getByRole("button", { name: "添加 1 个模型" });
    expect(enabledAdd.hasAttribute("disabled")).toBe(false);
    fireEvent.click(enabledAdd);
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onAdd.mock.calls[0]![0][0]).toMatchObject({
      id: "gemini-4-carbon",
      api: "openai-responses",
    });
  });

  it("inherits an explicit provider endpoint rather than copying the catalog transport", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <FetchModelsDialog
        open
        provider={{ ...provider, api: "openai-completions" }}
        onOpenChange={() => {}}
        onAdd={onAdd}
        onManualAdd={() => {}}
      />,
      { wrapper: env.wrapper },
    );
    await chooseModel();
    expect(screen.getByRole("radio", { name: "继承服务商" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个模型" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onAdd.mock.calls[0]![0][0]).not.toHaveProperty("api");
  });

  it("keeps a failed import open and clears the endpoint choice on reopen", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("revision conflict"));
    const onOpenChange = vi.fn();
    const props = { provider, onOpenChange, onAdd, onManualAdd: () => {} };
    const view = render(<FetchModelsDialog open {...props} />, { wrapper: env.wrapper });
    await chooseModel();
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI Responses" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个模型" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onOpenChange).not.toHaveBeenCalled();
    view.rerender(<FetchModelsDialog open={false} {...props} />);
    view.rerender(<FetchModelsDialog open {...props} />);
    await chooseModel();
    expect(
      screen.getByRole("radio", { name: "OpenAI Responses" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: "添加 1 个模型" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});

describe("import address inheritance", () => {
  it("requires and persists a batch URL when neither model nor provider has one", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <FetchModelsDialog
        open
        provider={{ ...provider, baseUrl: "" }}
        onOpenChange={() => {}}
        onAdd={onAdd}
        onManualAdd={() => {}}
      />,
      { wrapper: env.wrapper },
    );
    await chooseModel();
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI Responses" }));
    expect(screen.getByRole("button", { name: "添加 1 个模型" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("模型 Base URL"), {
      target: { value: "https://batch.invalid/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个模型" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onAdd.mock.calls[0]![0][0]).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://batch.invalid/v1",
    });
  });

  it("allows builtin inheritance without inventing model API or URL", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <FetchModelsDialog
        open
        provider={{ ...provider, id: "google", baseUrl: "", overridesBuiltin: true }}
        onOpenChange={() => {}}
        onAdd={onAdd}
        onManualAdd={() => {}}
      />,
      { wrapper: env.wrapper },
    );
    await chooseModel();
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个模型" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onAdd.mock.calls[0]![0][0]).not.toHaveProperty("api");
    expect(onAdd.mock.calls[0]![0][0]).not.toHaveProperty("baseUrl");
  });
});

describe("model-specific address and builtin defaults", () => {
  it("saves a separate model URL without losing passthrough fields", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const original = {
      id: "custom",
      api: "anthropic-messages",
      baseUrl: "https://old.invalid",
      extra: { preserve: true },
      headers: { sample: "header" },
    };
    render(
      <ModelEditorDialog
        open
        model={original}
        providerApi=""
        providerBaseUrl={provider.baseUrl}
        defaultLevel={undefined}
        otherIds={new Set()}
        onOpenChange={() => {}}
        onSave={onSave}
      />,
      { wrapper: env.wrapper },
    );
    fireEvent.change(screen.getByLabelText("模型 Base URL"), {
      target: { value: "https://new.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(modelConfigFromDraft(onSave.mock.calls[0]![0], original)).toMatchObject({
      ...original,
      baseUrl: "https://new.invalid",
    });
  });

  it("allows a builtin model to keep its builtin API and URL", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditorDialog
        open
        model={{ id: "custom" }}
        providerApi=""
        providerBaseUrl=""
        overridesBuiltin
        defaultLevel={undefined}
        otherIds={new Set()}
        onOpenChange={() => {}}
        onSave={onSave}
      />,
      { wrapper: env.wrapper },
    );
    expect(screen.getByRole("radio", { name: "继承内置默认值" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const config = modelConfigFromDraft(onSave.mock.calls[0]![0], { id: "custom" });
    expect(config).not.toHaveProperty("api");
    expect(config).not.toHaveProperty("baseUrl");
  });
});
