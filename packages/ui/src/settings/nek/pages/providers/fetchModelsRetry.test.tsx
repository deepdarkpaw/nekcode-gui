// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NekFetchModelsResult, NekProviderView } from "@zcode/shared/nek-protocol";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { FetchModelsDialog } from "./FetchModelsDialog.js";

const provider: NekProviderView = {
  id: "newapi",
  name: "NEWAPI",
  api: "openai-responses",
  baseUrl: "https://gateway.invalid/v1",
  apiKey: { kind: "literal", masked: "••••1234" },
  overridesBuiltin: false,
  models: [],
};
const result: NekFetchModelsResult = {
  ok: true,
  endpoint: `${provider.baseUrl}/models`,
  models: [{ id: "gpt-6.1-sol" }],
};
const callbacks = () => ({ onOpenChange: vi.fn(), onAdd: vi.fn(), onManualAdd: vi.fn() });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(installDomPolyfills);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("model list retry", () => {
  it.each([
    provider,
    { ...provider, api: "", models: [{ id: "existing", api: "openai-responses" }] },
  ])(
    "MF3: forwards the configured endpoint without requiring a runtime model ($api)",
    async (saved) => {
      const env = createNekTestEnv();
      const fetch = vi.spyOn(env.config, "fetchProviderModels").mockResolvedValue(result);
      vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([]);
      render(<FetchModelsDialog open provider={saved} {...callbacks()} />, {
        wrapper: env.wrapper,
      });
      await screen.findByRole("list", { name: "可添加的模型" });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        { kind: "local" },
        {
          providerId: "newapi",
          draft: { api: "openai-responses", baseUrl: provider.baseUrl },
        },
      );
    },
  );

  it("MF3: mixed model APIs are not guessed from the first model", async () => {
    const env = createNekTestEnv();
    const fetch = vi.spyOn(env.config, "fetchProviderModels").mockResolvedValue(result);
    vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([]);
    render(
      <FetchModelsDialog
        open
        provider={{
          ...provider,
          api: "",
          models: [
            { id: "a", api: "openai-responses" },
            { id: "b", api: "anthropic-messages" },
          ],
        }}
        {...callbacks()}
      />,
      { wrapper: env.wrapper },
    );
    await screen.findByRole("list", { name: "可添加的模型" });
    expect(fetch.mock.calls[0]?.[1]).toEqual({ providerId: "newapi" });
  });

  it("MF2/MF4: every explicit retry is a new pending request and can recover", async () => {
    const env = createNekTestEnv();
    const pending = deferred<NekFetchModelsResult>();
    const fetch = vi
      .spyOn(env.config, "fetchProviderModels")
      .mockRejectedValueOnce(new Error("Provider newapi does not declare a model API"))
      .mockImplementationOnce(() => pending.promise);
    vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([]);
    render(<FetchModelsDialog open provider={provider} {...callbacks()} />, {
      wrapper: env.wrapper,
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not declare a model API",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("正在请求模型列表…").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => pending.resolve(result));
    expect((await screen.findByRole("list", { name: "可添加的模型" })).textContent).toContain(
      "gpt-6.1-sol",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
  });

  it("MF2/MF4: a failed retry shows its new error instead of retaining the first one", async () => {
    const env = createNekTestEnv();
    const fetch = vi
      .spyOn(env.config, "fetchProviderModels")
      .mockRejectedValueOnce(new Error("old failure"))
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        endpoint: result.endpoint,
        message: "new auth failure",
      });
    render(<FetchModelsDialog open provider={provider} {...callbacks()} />, {
      wrapper: env.wrapper,
    });
    expect((await screen.findByRole("alert")).textContent).toContain("old failure");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("new auth failure"),
    );
    expect(screen.getByRole("alert").textContent).not.toContain("old failure");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("MF4: closing an inflight fetch does not start a stale catalog read", async () => {
    const env = createNekTestEnv();
    const pending = deferred<NekFetchModelsResult>();
    vi.spyOn(env.config, "fetchProviderModels").mockImplementation(() => pending.promise);
    const catalog = vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([]);
    const props = { provider, ...callbacks() };
    const view = render(<FetchModelsDialog open {...props} />, { wrapper: env.wrapper });
    view.rerender(<FetchModelsDialog open={false} {...props} />);
    await act(async () => pending.resolve(result));
    expect(catalog).not.toHaveBeenCalled();
  });

  it("MF3/MF4: changed provider settings replace a late request without publishing old models", async () => {
    const env = createNekTestEnv();
    const old = deferred<NekFetchModelsResult>();
    const fetch = vi
      .spyOn(env.config, "fetchProviderModels")
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ ...result, models: [{ id: "fresh-model" }] });
    const catalog = vi.spyOn(env.config, "getModelCatalog").mockResolvedValue([]);
    const props = callbacks();
    const view = render(<FetchModelsDialog open provider={provider} {...props} />, {
      wrapper: env.wrapper,
    });
    view.rerender(
      <FetchModelsDialog
        open
        provider={{ ...provider, baseUrl: "https://new.invalid/v1" }}
        {...props}
      />,
    );
    expect((await screen.findByRole("list", { name: "可添加的模型" })).textContent).toContain(
      "fresh-model",
    );
    await act(async () => old.resolve(result));
    expect(fetch.mock.calls[1]?.[1]).toEqual({
      providerId: "newapi",
      draft: { api: "openai-responses", baseUrl: "https://new.invalid/v1" },
    });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "可添加的模型" }).textContent).not.toContain(
      "gpt-6.1-sol",
    );
  });
});
