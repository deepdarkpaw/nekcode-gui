// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createNekTestEnv, installDomPolyfills, type NekTestEnv } from "../../test/nekTestUtils.js";
import { BaseUrlPreview } from "../../components/BaseUrlPreview.js";
import { ModelEditorDialog } from "./ModelEditorDialog.js";
import { ModelImportEndpoints } from "./ModelImportEndpoints.js";
import { modelConfigFromDraft } from "./modelDraft.js";

let env: NekTestEnv;
beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv();
});
afterEach(cleanup);
const providerUrl = "https://gateway.invalid/v1";

it("shows the inherited native Gemini request rather than hiding it behind an empty URL field", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const model = { id: "gemini-4-carbon", api: "google-generative-ai" };
  render(
    <ModelEditorDialog
      open
      model={model}
      providerApi=""
      providerBaseUrl={providerUrl}
      defaultLevel={undefined}
      otherIds={new Set()}
      onOpenChange={() => {}}
      onSave={onSave}
    />,
    { wrapper: env.wrapper },
  );
  const url = screen.getByLabelText("模型 Base URL") as HTMLInputElement;
  expect(url.value).toBe("");
  expect(
    screen.getByText(`${providerUrl}/models/gemini-4-carbon:streamGenerateContent?alt=sse`),
  ).toBeTruthy();
  expect(screen.getByText(/Google Gemini 使用原生/).textContent).toContain("以服务商文档为准");
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(url, { target: { value: "https://gateway.invalid/v1beta" } });
  expect(
    screen.getByText(
      "https://gateway.invalid/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(modelConfigFromDraft(onSave.mock.calls[0]![0], model)).toMatchObject({
    ...model,
    baseUrl: "https://gateway.invalid/v1beta",
  });
});

it("switching API previews a different wire route without silently changing the URL", () => {
  render(
    <ModelEditorDialog
      open
      model={{ id: "gemini-4-carbon" }}
      providerApi="openai-responses"
      providerBaseUrl={providerUrl}
      defaultLevel={undefined}
      otherIds={new Set()}
      onOpenChange={() => {}}
      onSave={async () => {}}
    />,
    { wrapper: env.wrapper },
  );
  expect(screen.getByText(`${providerUrl}/responses`)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Google Gemini" }));
  expect(
    screen.getByText(`${providerUrl}/models/gemini-4-carbon:streamGenerateContent?alt=sse`),
  ).toBeTruthy();
  expect((screen.getByLabelText("模型 Base URL") as HTMLInputElement).value).toBe("");
});

it("batch import uses the same native route preview and never rewrites the provider", () => {
  const onApiChange = vi.fn(),
    onBaseUrlChange = vi.fn();
  render(
    <ModelImportEndpoints
      provider={{
        id: "CPA",
        api: "",
        baseUrl: providerUrl,
        apiKey: { kind: "none" },
        models: [],
        overridesBuiltin: false,
      }}
      api="google-generative-ai"
      baseUrl=""
      baseUrlInvalid={false}
      onApiChange={onApiChange}
      onBaseUrlChange={onBaseUrlChange}
    />,
    { wrapper: env.wrapper },
  );
  expect(
    screen.getByText(`${providerUrl}/models/{model}:streamGenerateContent?alt=sse`),
  ).toBeTruthy();
  expect(onApiChange).not.toHaveBeenCalled();
  expect(onBaseUrlChange).not.toHaveBeenCalled();
});

it("unknown API does not acquire a guessed OpenAI request preview", () => {
  const view = render(
    <BaseUrlPreview api="custom-transport" value={providerUrl} onFix={() => {}} />,
    { wrapper: env.wrapper },
  );
  expect(view.container.textContent).toBe("");
});

it("URL suggestions only change the unsaved field when explicitly applied", () => {
  const onFix = vi.fn();
  render(
    <BaseUrlPreview
      api="google-generative-ai"
      value="https://gateway.invalid"
      modelId="models/gemini-4-carbon"
      onFix={onFix}
    />,
    { wrapper: env.wrapper },
  );
  expect(
    screen.getByText(
      "https://gateway.invalid/models/gemini-4-carbon:streamGenerateContent?alt=sse",
    ),
  ).toBeTruthy();
  expect(onFix).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(onFix).toHaveBeenCalledWith("https://gateway.invalid/v1beta");
});
