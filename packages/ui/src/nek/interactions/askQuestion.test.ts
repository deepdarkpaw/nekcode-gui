import { describe, expect, it } from "vitest";
import type { NekAskQuestionPayload } from "@zcode/shared/nek-protocol";
import { buildAskQuestionResult, validateAskQuestionAnswers } from "./askQuestion.js";
import { resolveAskQuestionKey, caretLinePosition, getAskQuestionOptionTabIndex } from "./askQuestionKeyboard.js";
import {
  createAskQuestionState,
  reduceAskQuestion,
  isAskQuestionAnswered,
} from "./askQuestionReducer.js";

const payload: NekAskQuestionPayload = {
  title: "Choose",
  questions: [
    {
      id: "one",
      prompt: "One?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
    {
      id: "many",
      prompt: "Many?",
      allow_multiple: true,
      options: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    },
  ],
};

function key(
  patch: Partial<Parameters<typeof resolveAskQuestionKey>[0]>,
): Parameters<typeof resolveAskQuestionKey>[0] {
  return {
    key: "?",
    focusTarget: "card",
    active: -1,
    optionCount: 2,
    allowMultiple: false,
    questionIndex: 0,
    canSubmit: false,
    otherValue: "",
    ...patch,
  };
}

describe("ask_question answers", () => {
  it("AQ-1.1/AQ-1.2: builds one answer for every question and trims Other", () => {
    expect(
      buildAskQuestionResult(payload, [
        { questionId: "one", selected: ["b"], other: "" },
        { questionId: "many", selected: ["x", "y"], other: "  custom  " },
      ]),
    ).toEqual({
      answers: [
        { questionId: "one", selected: ["b"] },
        { questionId: "many", selected: ["x", "y"], other: "custom" },
      ],
    });
  });

  it("AQ-1.3: rejects empty answers, unknown options, duplicate options, and invalid single choice", () => {
    expect(validateAskQuestionAnswers(payload, [
      { questionId: "one", selected: [], other: "" },
      { questionId: "many", selected: ["x"], other: "" },
    ]).valid).toBe(false);
    expect(validateAskQuestionAnswers(payload, [
      { questionId: "one", selected: ["missing"], other: "" },
      { questionId: "many", selected: ["x"], other: "" },
    ]).valid).toBe(false);
    expect(validateAskQuestionAnswers(payload, [
      { questionId: "one", selected: ["a", "b"], other: "" },
      { questionId: "many", selected: ["x"], other: "" },
    ]).valid).toBe(false);
  });

  it("AQ-1.4: treats non-empty Other as an answer and keeps it mutually exclusive for single choice", () => {
    expect(validateAskQuestionAnswers(payload, [
      { questionId: "one", selected: [], other: "other" },
      { questionId: "many", selected: ["x"], other: "" },
    ]).valid).toBe(true);
    expect(validateAskQuestionAnswers(payload, [
      { questionId: "one", selected: ["a"], other: "other" },
      { questionId: "many", selected: ["x"], other: "" },
    ]).valid).toBe(false);
  });
});

describe("ask_question reducer", () => {
  it("AQ-C1/AQ-K9/AQ-K11: single selection clears Other and selects one option", () => {
    let state = createAskQuestionState(payload);
    state = reduceAskQuestion(state, payload, { type: "setOther", value: "custom" });
    state = reduceAskQuestion(state, payload, { type: "selectOption", optionId: "a" });
    expect(state.drafts.one).toEqual({ selected: ["a"], other: "" });
    expect(state.active).toBe(0);
  });

  it("AQ-C2/AQ-K10/AQ-1.5: multi-select toggles options and keeps Other", () => {
    let state = createAskQuestionState(payload);
    state = reduceAskQuestion(state, payload, { type: "setQuestion", index: 1 });
    state = reduceAskQuestion(state, payload, { type: "selectOption", optionId: "x" });
    state = reduceAskQuestion(state, payload, { type: "setOther", value: "custom" });
    expect(state.drafts.many).toEqual({ selected: ["x"], other: "custom" });
    state = reduceAskQuestion(state, payload, { type: "selectOption", optionId: "x" });
    expect(state.drafts.many).toEqual({ selected: [], other: "custom" });
  });

  it("AQ-1.6: entering non-empty Other clears a single selected option", () => {
    let state = createAskQuestionState(payload);
    state = reduceAskQuestion(state, payload, { type: "selectOption", optionId: "a" });
    state = reduceAskQuestion(state, payload, { type: "setOther", value: "custom" });
    expect(state.drafts.one).toEqual({ selected: [], other: "custom" });
  });

  it("AQ-F3/AQ-K5/AQ-K6: question navigation keeps the reducer pure and closes correctly", () => {
    const state = createAskQuestionState(payload);
    expect(reduceAskQuestion(state, payload, { type: "setQuestion", index: 1 }).questionIndex).toBe(1);
    expect(reduceAskQuestion(state, payload, { type: "setQuestion", index: 2 })).toBe(state);
    expect(reduceAskQuestion(state, payload, { type: "close", reason: "cancelled" }).closed).toBe("cancelled");
  });

  it("AQ-1.7: answered means an option or non-empty Other, never whitespace", () => {
    expect(isAskQuestionAnswered({ selected: [], other: "" })).toBe(false);
    expect(isAskQuestionAnswered({ selected: [], other: "  " })).toBe(false);
    expect(isAskQuestionAnswered({ selected: ["a"], other: "" })).toBe(true);
  });
});

describe("ask_question keyboard table", () => {
  const cases: Array<[
    string,
    Parameters<typeof resolveAskQuestionKey>[0],
    ReturnType<typeof resolveAskQuestionKey>,
  ]> = [
    ["AQ-K1: card down", key({ key: "ArrowDown" }), { type: "setActive", active: 0 }],
    ["AQ-K2: card up", key({ key: "ArrowUp" }), { type: "setActive", active: 2 }],
    ["AQ-K3: digit selects option", key({ key: "2" }), { type: "selectOption", index: 1, submit: true }],
    ["AQ-K4: card Enter unavailable", key({ key: "Enter" }), { type: "noop" }],
    ["AQ-K4: card Enter submits", key({ key: "Enter", canSubmit: true }), { type: "primary" }],
    ["AQ-K5: card Escape previous", key({ key: "Escape", questionIndex: 1 }), { type: "previous" }],
    ["AQ-K6: card Escape dismisses", key({ key: "Escape" }), { type: "dismiss" }],
    ["AQ-K7: option right wraps", key({ key: "ArrowRight", focusTarget: "option", active: 1 }), { type: "setActive", active: 2 }],
    ["AQ-K8: option left wraps", key({ key: "ArrowLeft", focusTarget: "option", active: 0 }), { type: "setActive", active: 2 }],
    ["AQ-K9: single option Space", key({ key: " ", focusTarget: "option", active: 0 }), { type: "selectOption", index: 0, submit: true }],
    ["AQ-K10: multi option Space", key({ key: " ", focusTarget: "option", active: 0, allowMultiple: true }), { type: "selectOption", index: 0, submit: false }],
    ["AQ-K11: single option Enter", key({ key: "Enter", focusTarget: "option", active: 0 }), { type: "selectOption", index: 0, submit: true }],
    ["AQ-K12: multi option Enter checks", key({ key: "Enter", focusTarget: "option", active: 0, allowMultiple: true }), { type: "selectOption", index: 0, submit: false }],
    ["AQ-K12: multi option Enter submits", key({ key: "Enter", focusTarget: "option", active: 0, allowMultiple: true, canSubmit: true }), { type: "primary" }],
    ["AQ-K13: option Escape", key({ key: "Escape", focusTarget: "option", active: 0 }), { type: "dismiss" }],
    ["AQ-K14: option Home", key({ key: "Home", focusTarget: "option", active: 1 }), { type: "setActive", active: 0 }],
    ["AQ-K14: option End", key({ key: "End", focusTarget: "option", active: 0 }), { type: "setActive", active: 2 }],
    ["AQ-K15: Other Enter unavailable", key({ key: "Enter", focusTarget: "other" }), { type: "noop" }],
    ["AQ-K15: Other Enter submits", key({ key: "Enter", focusTarget: "other", canSubmit: true }), { type: "primary" }],
    ["AQ-K17: Other Cmd Enter", key({ key: "Enter", focusTarget: "other", metaKey: true, canSubmit: true }), { type: "primary" }],
    ["AQ-K20: Other Escape returns card", key({ key: "Escape", focusTarget: "other", otherValue: "text" }), { type: "setActive", active: -1 }],
    ["AQ-K21: empty Other Escape dismisses", key({ key: "Escape", focusTarget: "other" }), { type: "dismiss" }],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(resolveAskQuestionKey(input)).toEqual(expected);
  });

  it("AQ-K16/AQ-K23: Shift+Enter and Tab remain native", () => {
    expect(resolveAskQuestionKey(key({ key: "Enter", focusTarget: "other", shiftKey: true }))).toBeNull();
    expect(resolveAskQuestionKey(key({ key: "Tab" }))).toBeNull();
  });

  it("AQ-K18/AQ-K19: Other arrows leave the textarea only at hard line edges", () => {
    expect(resolveAskQuestionKey(key({ key: "ArrowUp", focusTarget: "other", caretOnFirstLine: true }))).toEqual({ type: "setActive", active: 1 });
    expect(resolveAskQuestionKey(key({ key: "ArrowDown", focusTarget: "other", caretOnLastLine: true }))).toEqual({ type: "setActive", active: 0 });
    expect(resolveAskQuestionKey(key({ key: "ArrowUp", focusTarget: "other" }))).toBeNull();
  });

  it("AQ-K22: IME and keyCode 229 never become commands", () => {
    expect(resolveAskQuestionKey(key({ key: "Enter", isComposing: true }))).toBeNull();
    expect(resolveAskQuestionKey(key({ key: "Escape", keyCode: 229 }))).toBeNull();
  });

  it("AQ-K23: option roving tab index and hard newline caret helper are deterministic", () => {
    expect([0, 1, 2].map((index) => getAskQuestionOptionTabIndex(-1, index))).toEqual([0, -1, -1]);
    expect([0, 1, 2].map((index) => getAskQuestionOptionTabIndex(1, index))).toEqual([-1, 0, -1]);
    expect(caretLinePosition({ value: "a\nb", selectionStart: 0 })).toEqual({ onFirstLine: true, onLastLine: false });
    expect(caretLinePosition({ value: "a\nb", selectionStart: 3 })).toEqual({ onFirstLine: false, onLastLine: true });
  });

  it("AQ-K2/AQ-K3: modifiers and out-of-range digits are not handled", () => {
    expect(resolveAskQuestionKey(key({ key: "2", ctrlKey: true }))).toBeNull();
    expect(resolveAskQuestionKey(key({ key: "9" }))).toBeNull();
  });
});
