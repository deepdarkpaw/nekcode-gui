// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NekModelConfig, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { mergeFetchedModels, modelConfigFromRow } from "../../lib/fetchedModels.js";
import { thinkingDraftFromModel, thinkingFieldsFromDraft } from "../../lib/thinkingLevels.js";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { ModelEditorDialog } from "./ModelEditorDialog.js";
import { modelConfigFromDraft, type ModelDraft } from "./modelDraft.js";
import { modelThinkingLevels } from "./ModelTable.js";

const LOCAL = { kind: "local" as const };
const model: NekModelConfig = {
  id: "gpt-6.1-sol",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null },
};
const BASIC_LEVELS: NekThinkingLevel[] = ["low", "medium", "high"];
const FIVE_LEVELS: NekThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

beforeEach(installDomPolyfills);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("thinking level configuration", () => {
  it("TL1/TL2: implicit advanced levels are absent from both the table and editor draft", () => {
    expect(modelThinkingLevels(model)).toEqual(BASIC_LEVELS);
    expect([...thinkingDraftFromModel(model).enabled]).toEqual(BASIC_LEVELS);
    expect(modelThinkingLevels({ ...model, reasoning: false })).toEqual([]);
  });

  it("TL3: selecting advanced levels writes explicit mappings even with blank raw inputs", () => {
    const draft = thinkingDraftFromModel(model);
    expect(
      thinkingFieldsFromDraft({ ...draft, enabled: new Set(FIVE_LEVELS), raw: { max: "  " } }),
    ).toEqual({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    });
  });

  it("TL3/TL5: custom mappings survive save/reopen and disabled levels stay null", () => {
    const fields = thinkingFieldsFromDraft({
      reasoning: true,
      enabled: new Set(FIVE_LEVELS),
      raw: { high: " 32000 ", xhigh: " extra-high ", max: "xhigh", off: "none" },
    });
    expect(fields.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      high: "32000",
      xhigh: "extra-high",
      max: "xhigh",
    });
    const reopened = thinkingDraftFromModel(fields);
    expect([...reopened.enabled]).toEqual(FIVE_LEVELS);
    expect(reopened.raw).toEqual({ high: "32000", xhigh: "extra-high", max: "xhigh" });
    expect(
      thinkingFieldsFromDraft({ ...reopened, enabled: new Set<NekThinkingLevel>(BASIC_LEVELS) })
        .thinkingLevelMap,
    ).toEqual({ off: null, minimal: null, high: "32000", xhigh: null, max: null });
    expect(thinkingFieldsFromDraft({ ...reopened, reasoning: false })).toEqual({
      reasoning: false,
      thinkingLevelMap: undefined,
    });
  });

  it("TL3: clearing an enabled advanced raw value restores an explicit identity mapping", () => {
    const draft = thinkingDraftFromModel({
      reasoning: true,
      thinkingLevelMap: { xhigh: "", max: "" },
    });
    expect(thinkingFieldsFromDraft(draft).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
  });

  it("TL4: imports retain both advanced levels instead of silently omitting their mappings", () => {
    const [row] = mergeFetchedModels(
      [{ id: model.id, reasoning: true, thinkingLevels: FIVE_LEVELS }],
      [],
      new Set(),
    );
    const saved = modelConfigFromRow(row!);
    expect(saved.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      xhigh: "xhigh",
      max: "max",
    });
    expect(modelThinkingLevels(saved)).toEqual(FIVE_LEVELS);
    expect([...thinkingDraftFromModel(saved).enabled]).toEqual(FIVE_LEVELS);
  });

  it("TL4: importing every level still writes the two required advanced mappings", () => {
    const [row] = mergeFetchedModels(
      [{ id: model.id, reasoning: true, thinkingLevels: [...NEK_THINKING_LEVELS] }],
      [],
      new Set(),
    );
    expect(modelConfigFromRow(row!).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
  });

  it("TL4: imports preserve catalog raw mappings without borrowing routing", () => {
    const [row] = mergeFetchedModels(
      [{ id: model.id }],
      [
        {
          provider: "openai",
          id: model.id,
          name: model.id,
          api: "openai-responses",
          reasoning: true,
          thinkingLevels: FIVE_LEVELS,
          thinkingLevelMap: { off: null, minimal: null, xhigh: "very_high", max: "xhigh" },
          contextWindow: 800_000,
          maxTokens: 125_000,
          input: ["text"],
        },
      ],
      new Set(),
    );
    const saved = modelConfigFromRow(row!);
    expect(saved.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      xhigh: "very_high",
      max: "xhigh",
    });
    expect(saved).not.toHaveProperty("api");
    expect(saved).not.toHaveProperty("baseUrl");
  });

  it("TL2/TL3/TL5: checkbox selection survives persistence, reopen and chat option projection", async () => {
    const env = createNekTestEnv();
    const initial = await env.config.readModelsConfig(LOCAL);
    await env.config.addModels(LOCAL, "deepseek", [model], { revision: initial.revision });
    const onSave = vi.fn(async (draft: ModelDraft) => {
      const doc = await env.config.readModelsConfig(LOCAL);
      await env.config.saveModel(LOCAL, "deepseek", modelConfigFromDraft(draft, model), {
        revision: doc.revision,
      });
    });
    const props = {
      providerApi: "openai-responses",
      providerBaseUrl: "https://gateway.invalid/v1",
      defaultLevel: undefined,
      otherIds: new Set<string>(),
      onOpenChange: () => {},
      onSave,
    };
    const view = render(<ModelEditorDialog open model={model} {...props} />, {
      wrapper: env.wrapper,
    });
    for (const name of ["很高", "最高"]) {
      const checkbox = screen.getByRole("checkbox", { name });
      expect(checkbox.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(checkbox);
    }
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    await waitFor(async () => {
      const doc = await env.config.readModelsConfig(LOCAL);
      const saved = doc.providers
        .find((provider) => provider.id === "deepseek")!
        .models.find((candidate) => candidate.id === model.id)!;
      expect(saved.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        xhigh: "xhigh",
        max: "max",
      });
    });
    const available = await env.config.listAvailableModels(LOCAL);
    const saved = available.find((candidate) => candidate.id === model.id)!;
    expect(saved.thinkingLevels).toEqual(FIVE_LEVELS);
    expect(modelThinkingLevels(saved)).toEqual(FIVE_LEVELS);
    const option = resolveModelThoughtOption({
      providerId: "deepseek",
      modelId: model.id,
      currentValue: "max",
      modelSelectionView: {
        revision: 1,
        scope: { patterns: [], models: [], diagnostics: [] },
        providers: [
          {
            providerId: "deepseek",
            displayName: "DeepSeek",
            models: [
              {
                modelId: saved.id,
                displayName: saved.name,
                reasoningLevels: saved.thinkingLevels,
                supportsImage: false,
              },
            ],
          },
        ],
      },
    });
    expect(option?.options?.map((entry) => entry.value)).toEqual(FIVE_LEVELS);
    expect(option?.currentValue).toBe("max");
    view.rerender(<ModelEditorDialog open={false} model={saved} {...props} />);
    view.rerender(<ModelEditorDialog open model={saved} {...props} />);
    for (const name of ["很高", "最高"]) {
      expect(screen.getByRole("checkbox", { name }).getAttribute("aria-checked")).toBe("true");
    }
  });
});
