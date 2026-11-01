// @vitest-environment happy-dom
/**
 * 模型菜单只投影 Selection View 的事实：不按端点/账号二次过滤，且模型 id 原样保留
 * （nek 的模型 id 允许包含 "/"，不能被 "provider/model" 字符串重新解析截断）。
 */
import type { ModelSelectionView } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { buildModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

const VIEW: ModelSelectionView = {
  revision: 7,
  providers: [
    {
      providerId: "mock",
      displayName: "公司网关",
      models: [
        {
          modelId: "mock-model",
          displayName: "Local Mock Model",
          reasoningLevels: ["off"],
          supportsImage: false,
        },
        {
          modelId: "vendor/mock-model-2",
          displayName: "Local Mock Model 2",
          reasoningLevels: ["off", "high"],
          supportsImage: true,
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

describe("buildModelSelectGroups", () => {
  it("keeps provider and model ids exactly as the view reports them", () => {
    const groups = buildModelSelectGroups(VIEW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("公司网关");
    const values = groups[0]!.items.map((item) => item.value);
    expect(values.map((value) => decodeCustomModelValue(value))).toEqual([
      { providerId: "mock", modelName: "mock-model" },
      { providerId: "mock", modelName: "vendor/mock-model-2" },
    ]);
    expect(groups[0]!.items[1]).toMatchObject({ supportsVisionInput: true });
    expect(groups[0]!.items[0]).not.toHaveProperty("supportsVisionInput");
  });

  it("an empty view yields no groups (配置需求由门禁横幅回答)", () => {
    expect(buildModelSelectGroups({ revision: 1, providers: [] })).toEqual([]);
  });

  it('a menu selection survives submission unchanged, including ids with "/"', () => {
    const groups = buildModelSelectGroups(VIEW);
    const value = groups[0]!.items[1]!.value;
    const decoded = decodeCustomModelValue(value);
    expect(decoded).not.toBeNull();
    const selection = {
      providerId: decoded!.providerId,
      modelId: decoded!.modelName!,
      options: { reasoningLevel: "high" },
    };
    const submission = createComposerSubmissionConfig(
      { mode: "agent", planEnabled: false, modelSelection: selection },
      VIEW,
    );
    expect(submission?.modelSelection).toEqual(selection);
  });
});
