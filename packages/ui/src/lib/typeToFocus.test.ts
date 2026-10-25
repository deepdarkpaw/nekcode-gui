import { describe, expect, it } from "vitest";
import {
  isEditableElement,
  isPrintableKeyEvent,
  shouldTypeToFocus,
  type TypeToFocusContext,
  type TypeToFocusKeyEvent,
} from "./typeToFocus.js";

const key = (value: string, patch: Partial<TypeToFocusKeyEvent> = {}): TypeToFocusKeyEvent => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...patch,
});

const idle: TypeToFocusContext = { idle: true, editable: false, ownsKeys: false };
const onButton: TypeToFocusContext = { idle: false, editable: false, ownsKeys: false };

describe("isPrintableKeyEvent", () => {
  it("accepts single printable characters including CJK and emoji", () => {
    expect(isPrintableKeyEvent(key("a"))).toBe(true);
    expect(isPrintableKeyEvent(key("A"))).toBe(true);
    expect(isPrintableKeyEvent(key("中"))).toBe(true);
    expect(isPrintableKeyEvent(key("😀"))).toBe(true);
  });

  it("rejects named keys, shortcuts, IME composition and consumed events", () => {
    expect(isPrintableKeyEvent(key("Enter"))).toBe(false);
    expect(isPrintableKeyEvent(key("ArrowUp"))).toBe(false);
    expect(isPrintableKeyEvent(key("k", { ctrlKey: true }))).toBe(false);
    expect(isPrintableKeyEvent(key("k", { metaKey: true }))).toBe(false);
    expect(isPrintableKeyEvent(key("m", { altKey: true }))).toBe(false);
    expect(isPrintableKeyEvent(key("Process", { keyCode: 229 }))).toBe(false);
    expect(isPrintableKeyEvent(key("a", { isComposing: true }))).toBe(false);
    expect(isPrintableKeyEvent(key("a", { defaultPrevented: true }))).toBe(false);
  });
});

describe("shouldTypeToFocus", () => {
  it("redirects printable keys when focus is idle or on a non-editable control", () => {
    expect(shouldTypeToFocus(key("h"), idle)).toBe(true);
    expect(shouldTypeToFocus(key("h"), onButton)).toBe(true);
  });

  it("never hijacks keys inside editable elements or key-owning widgets", () => {
    expect(shouldTypeToFocus(key("h"), { ...onButton, editable: true })).toBe(false);
    expect(shouldTypeToFocus(key("h"), { ...onButton, ownsKeys: true })).toBe(false);
  });

  it("keeps Space as the activation key when a control has focus", () => {
    expect(shouldTypeToFocus(key(" "), onButton)).toBe(false);
    expect(shouldTypeToFocus(key(" "), idle)).toBe(true);
  });
});

describe("isEditableElement", () => {
  it("is false without a DOM element", () => {
    expect(isEditableElement(null)).toBe(false);
  });
});
