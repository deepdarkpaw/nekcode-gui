import { describe, expect, it } from "vitest";
import { resolveExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";

describe("resolveExternalWorkspaceOpenDialogCopy", () => {
  it("中文确认框使用 nekcode 品牌，不再出现旧品牌", () => {
    const copy = resolveExternalWorkspaceOpenDialogCopy("zh-CN");

    expect(copy.title).toBe("打开外部 nekcode 链接？");
    expect(copy.message).toBe("是否在 nekcode 中打开此文件夹？");
    expect(`${copy.title}${copy.message}`).not.toMatch(/zcode/iu);
  });

  it("英文确认框使用 nekcode 品牌", () => {
    const copy = resolveExternalWorkspaceOpenDialogCopy("en-US");

    expect(copy.title).toBe("Open external nekcode link?");
    expect(copy.message).toBe("Open this folder in nekcode?");
    expect(`${copy.title}${copy.message}`).not.toMatch(/zcode/iu);
  });
});
