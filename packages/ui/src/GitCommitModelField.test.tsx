// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { GitCommitModelField } from "./GitCommitModelField.js";

beforeAll(installDomPolyfills);
afterEach(cleanup);
it("selects a model by exact host provider/id, restores it on reopen, and clears it", async () => {
  let preference: { providerId: string; modelId: string } | null = null;
  const save = vi.fn(async (model: typeof preference) => {
    preference = model;
  });
  const services = {
    gitService: { getCommitMessageModel: async () => preference, setCommitMessageModel: save },
    modelSelectionService: {
      getView: async () => ({
        providers: [
          { providerId: "Box", models: [{ modelId: "team/summary", displayName: "Summary" }] },
        ],
      }),
      onDynamicDidChange: () => () => ({ dispose() {} }),
    },
  } as unknown as IServiceAccessor;
  const show = () =>
    render(
      <ServiceProvider services={services}>
        <ZCodeIntlProvider initialLocale="en-US">
          <GitCommitModelField workspacePath="/repo" disabled={false} onSaving={() => {}} />
        </ZCodeIntlProvider>
      </ServiceProvider>,
    );
  async function choose(name: RegExp) {
    const trigger = screen.getByRole("combobox", { name: "Commit message model" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name }));
  }
  const first = show();
  await choose(/Summary/);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ providerId: "Box", modelId: "team/summary" }),
  );
  first.unmount();
  show();
  await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain("Summary"));
  await choose(/Use workspace default/);
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null));
});
