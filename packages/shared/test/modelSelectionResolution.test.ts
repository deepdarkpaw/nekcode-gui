import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "../src/model-selection.js";
import {
  completeNewModelSelection,
  resolveEffectiveModelSelection,
  resolveInitialModelSelection,
  validateModelSelectionOptions,
} from "../src/model-selection-resolution.js";

const catalog = {
  providers: [
    {
      providerId: "nek-provider",
      models: [
        { modelId: "unselectable", reasoningLevels: [] },
        { modelId: "model", reasoningLevels: ["off", "high"], defaultReasoningLevel: "high" },
      ],
    },
  ],
};
const selection: ModelSelection = {
  providerId: "nek-provider",
  modelId: "model",
  options: { reasoningLevel: "high" },
};

test("selection options require an explicit supported reasoning level", () => {
  const model = catalog.providers[0]!.models[1]!;
  assert.deepEqual(validateModelSelectionOptions(model, selection), { ok: true });
  assert.deepEqual(validateModelSelectionOptions(model, { ...selection, options: undefined }), {
    ok: false,
    code: "reasoning-level-missing",
    providerId: selection.providerId,
    modelId: selection.modelId,
  });
  const invalid = validateModelSelectionOptions(model, {
    ...selection,
    options: { reasoningLevel: "max" },
  });
  assert.deepEqual(invalid, {
    ok: false,
    code: "reasoning-level-not-supported",
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningLevel: "max",
    supportedLevels: ["off", "high"],
  });
  if (!invalid.ok && invalid.code === "reasoning-level-not-supported") {
    assert.ok(Object.isFrozen(invalid.supportedLevels));
    assert.notEqual(invalid.supportedLevels, model.reasoningLevels);
  }
});

test("effective selection reports missing provider/model without mutating intent", () => {
  for (const [input, issue] of [
    [null, "selection-missing"],
    [{ ...selection, providerId: "missing" }, "provider-not-found"],
    [{ ...selection, modelId: "missing" }, "model-not-found"],
  ] as const) {
    assert.deepEqual(resolveEffectiveModelSelection({ selection: input, catalog }), {
      effectiveSelection: null,
      selectionIssue: issue,
    });
  }
  assert.equal(selection.options?.reasoningLevel, "high");
});

test("effective selection retains identity but removes unsupported options", () => {
  const original = { ...selection, options: { reasoningLevel: "max" } };
  const result = resolveEffectiveModelSelection({ selection: original, catalog });
  assert.deepEqual(result, {
    effectiveSelection: { providerId: selection.providerId, modelId: selection.modelId },
    selectionIssue: "reasoning-level-not-supported",
  });
  assert.equal(original.options.reasoningLevel, "max");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.effectiveSelection));
});

test("effective supported selection is a frozen copy", () => {
  const result = resolveEffectiveModelSelection({ selection, catalog });
  assert.deepEqual(result, { effectiveSelection: selection });
  assert.notEqual(result.effectiveSelection, selection);
  assert.notEqual(result.effectiveSelection?.options, selection.options);
  assert.ok(Object.isFrozen(result.effectiveSelection?.options));
});

test("initial selection honors explicit nek defaults and their own thinking level", () => {
  assert.deepEqual(resolveInitialModelSelection({ catalog, configuredDefault: selection }), {
    selection,
    source: "configured-default",
  });
});

test("unavailable explicit defaults never select another model", () => {
  for (const modelId of ["missing", "unselectable"]) {
    assert.deepEqual(
      resolveInitialModelSelection({
        catalog,
        configuredDefault: { ...selection, modelId },
      }),
      {
        issue: "configured-default-unavailable",
        source: "configured-default",
      },
    );
  }
});

test("no explicit default uses catalog order and skips models without a default level", () => {
  assert.deepEqual(resolveInitialModelSelection({ catalog }), {
    selection,
    source: "catalog-default",
  });
  assert.deepEqual(resolveInitialModelSelection({ catalog: { providers: [] } }), {
    source: "none",
  });
});

test("active model selection completes with its own default, not old options", () => {
  const completed = completeNewModelSelection(catalog, {
    ...selection,
    options: { reasoningLevel: "off" },
  });
  assert.deepEqual(completed, selection);
  assert.ok(Object.isFrozen(completed));
  assert.ok(Object.isFrozen(completed?.options));
  assert.equal(completeNewModelSelection(catalog, { ...selection, modelId: "missing" }), undefined);
  assert.equal(
    completeNewModelSelection(catalog, { ...selection, modelId: "unselectable" }),
    undefined,
  );
});
