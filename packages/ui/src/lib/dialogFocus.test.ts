import { describe, expect, it } from "vitest";
import { pickFirstEmptyRequired, pickFirstInvalid, type FieldFocusState } from "./dialogFocus.js";

const field = (patch: Partial<FieldFocusState>): FieldFocusState => ({
  empty: false,
  required: false,
  disabled: false,
  invalid: false,
  ...patch,
});

describe("dialog focus selection", () => {
  it("picks the first empty required field that is enabled", () => {
    const fields = [
      field({ empty: true }),
      field({ required: true }),
      field({ required: true, empty: true, disabled: true }),
      field({ required: true, empty: true }),
      field({ required: true, empty: true }),
    ];
    expect(pickFirstEmptyRequired(fields)).toBe(3);
  });

  it("returns -1 when every required field is filled", () => {
    expect(pickFirstEmptyRequired([field({ required: true }), field({ empty: true })])).toBe(-1);
  });

  it("picks the first invalid enabled field", () => {
    const fields = [field({ invalid: true, disabled: true }), field({}), field({ invalid: true })];
    expect(pickFirstInvalid(fields)).toBe(2);
  });
});
