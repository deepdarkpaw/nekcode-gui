import { describe, expect, it } from "vitest";
import {
  ASYNC_ACTION_IDLE,
  describeAsyncError,
  reduceAsyncAction,
  type AsyncActionState,
} from "./asyncAction.js";

describe("reduceAsyncAction", () => {
  it("runs idle → pending → success → idle", () => {
    const pending = reduceAsyncAction(ASYNC_ACTION_IDLE, { type: "start" });
    expect(pending).toEqual({ status: "pending" });
    const success = reduceAsyncAction(pending, { type: "resolve" });
    expect(success).toEqual({ status: "success" });
    expect(reduceAsyncAction(success, { type: "reset" })).toBe(ASYNC_ACTION_IDLE);
  });

  it("ignores repeated starts while pending (no duplicate submit)", () => {
    const pending: AsyncActionState = { status: "pending" };
    expect(reduceAsyncAction(pending, { type: "start" })).toBe(pending);
  });

  it("keeps the failure reason and allows retrying", () => {
    const failed = reduceAsyncAction({ status: "pending" }, { type: "reject", message: "boom" });
    expect(failed).toEqual({ status: "error", message: "boom" });
    expect(reduceAsyncAction(failed, { type: "start" })).toEqual({ status: "pending" });
  });

  it("ignores results that arrive outside pending", () => {
    expect(reduceAsyncAction(ASYNC_ACTION_IDLE, { type: "resolve" })).toBe(ASYNC_ACTION_IDLE);
    expect(reduceAsyncAction(ASYNC_ACTION_IDLE, { type: "reject", message: "x" })).toBe(
      ASYNC_ACTION_IDLE,
    );
  });
});

describe("describeAsyncError", () => {
  it("uses the error message and strips duplicated prefixes", () => {
    expect(describeAsyncError(new Error("Error: disk full"), "fallback")).toBe("disk full");
  });

  it("uses the generic copy when the error has no message", () => {
    expect(describeAsyncError(new Error(""), "fallback")).toBe("fallback");
  });
});
