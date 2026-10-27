import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeZCodeTaskMode, zcodeTaskModeSchema } from "@zcode/shared";

describe("task mode convergence to agent | plan", () => {
  it("accepts only the two canonical modes", () => {
    for (const mode of ["agent", "plan"]) {
      assert.equal(zcodeTaskModeSchema.safeParse(mode).success, true, mode);
    }
    for (const retired of ["yolo", "edit", "auto", "autoEdit", "build", ""]) {
      assert.equal(zcodeTaskModeSchema.safeParse(retired).success, false, retired);
    }
  });

  it("migrates every retired persisted value", () => {
    // 旧值迁移表：五种「直接干活」的档位全部收敛到 agent，plan 保持 plan。
    const cases: Array<[string, "agent" | "plan"]> = [
      ["yolo", "agent"],
      ["edit", "agent"],
      ["auto", "agent"],
      ["autoEdit", "agent"],
      ["build", "agent"],
      ["full-auto", "agent"],
      ["full_auto", "agent"],
      ["plan", "plan"],
      ["read-only", "plan"],
      ["read_only", "plan"],
      ["  build  ", "agent"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeZCodeTaskMode(input), expected, input);
    }
  });

  it("rejects unknown and empty input instead of guessing a mode", () => {
    for (const input of ["", "   ", undefined, null, "turbo"]) {
      assert.equal(normalizeZCodeTaskMode(input), undefined, String(input));
    }
  });

  it("is idempotent on canonical values", () => {
    assert.equal(normalizeZCodeTaskMode("agent"), "agent");
    assert.equal(normalizeZCodeTaskMode("plan"), "plan");
  });
});
