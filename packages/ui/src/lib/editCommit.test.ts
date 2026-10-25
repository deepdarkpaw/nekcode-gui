import { describe, expect, it } from "vitest";
import { decideCommit, parseNumberDraft, parseTextDraft } from "./editCommit.js";

const formatMessage = ({ id }: { id: string }, values?: Record<string, string | number>) =>
  values ? `${id}:${JSON.stringify(values)}` : id;

describe("decideCommit (text)", () => {
  const parse = (draft: string) => parseTextDraft(draft);

  it("does not commit unchanged values (after trimming)", () => {
    expect(decideCommit({ draft: "  name ", current: "name", parse })).toEqual({
      kind: "unchanged",
    });
  });

  it("returns the validation error instead of committing", () => {
    const validate = (value: string) => (value === "" ? "required" : null);
    expect(decideCommit({ draft: "   ", current: "name", parse, validate })).toEqual({
      kind: "invalid",
      error: "required",
    });
  });

  it("commits the parsed value", () => {
    expect(decideCommit({ draft: " next ", current: "name", parse })).toEqual({
      kind: "commit",
      value: "next",
    });
  });

  it("can keep surrounding whitespace", () => {
    expect(parseTextDraft(" a ", false)).toEqual({ ok: true, value: " a " });
  });
});

describe("parseNumberDraft", () => {
  it("parses numbers within constraints", () => {
    expect(parseNumberDraft(" 30 ", { min: 1, max: 60, integer: true }, formatMessage)).toEqual({
      ok: true,
      value: 30,
    });
  });

  it("rejects empty, non-numeric, fractional and out-of-range input", () => {
    expect(parseNumberDraft("", {}, formatMessage)).toEqual({
      ok: false,
      error: "ui.field.error.notNumber",
    });
    expect(parseNumberDraft("abc", {}, formatMessage).ok).toBe(false);
    expect(parseNumberDraft("1.5", { integer: true }, formatMessage)).toEqual({
      ok: false,
      error: "ui.field.error.notInteger",
    });
    expect(parseNumberDraft("0", { min: 1 }, formatMessage)).toEqual({
      ok: false,
      error: 'ui.field.error.min:{"min":1}',
    });
    expect(parseNumberDraft("61", { max: 60 }, formatMessage)).toEqual({
      ok: false,
      error: 'ui.field.error.max:{"max":60}',
    });
  });

  it("treats numerically equal drafts as unchanged", () => {
    const parse = (draft: string) => parseNumberDraft(draft, {}, formatMessage);
    expect(decideCommit({ draft: "30.0", current: 30, parse })).toEqual({ kind: "unchanged" });
  });
});
