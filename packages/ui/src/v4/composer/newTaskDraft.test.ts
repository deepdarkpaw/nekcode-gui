// @vitest-environment happy-dom
/**
 * 新草稿初始化：显式默认不可用时不给选择（交给菜单重选），绝不静默换服务商。
 */
import type { ModelSelectionView } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { initializeNewTaskDraft } from "./newTaskDraft.js";

const VIEW: ModelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId: "mock",
      displayName: "Mock Provider",
      models: [
        {
          modelId: "mock-model",
          displayName: "Local Mock Model",
          reasoningLevels: ["off"],
          defaultReasoningLevel: "off",
          supportsImage: false,
        },
      ],
    },
  ],
  preferredSelection: {
    providerId: "mock",
    modelId: "mock-model",
    options: { reasoningLevel: "off" },
  },
};

describe("initializeNewTaskDraft", () => {
  it("采用 View 的首选选择", () => {
    const draft = initializeNewTaskDraft(
      { text: "hi", updatedAt: 0 },
      "/workspace",
      undefined,
      VIEW,
    );
    expect(draft.modelSelection).toEqual(VIEW.preferredSelection);
  });

  it("配置的默认模型不可用：不填选择（可见重选），不换成别的服务商", () => {
    const draft = initializeNewTaskDraft({ text: "hi", updatedAt: 0 }, "/workspace", undefined, {
      ...VIEW,
      preferredSelection: undefined,
      preferredSelectionIssue: "configured-default-unavailable",
    });
    expect(draft.modelSelection).toBeUndefined();
  });
});
