import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_V4_DRAFT_SCOPES,
  MAX_V4_DRAFT_TEXT_BYTES,
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "./composerDraftStore.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("composer draft persistence", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("P7: persists bounded text and serializable attachment references per session", () => {
    const localStorage = storage();
    (globalThis as { window?: unknown }).window = { localStorage };
    persistV4ComposerDraft("/workspace", undefined, "session-1", {
      text: "x".repeat(MAX_V4_DRAFT_TEXT_BYTES + 100),
      mode: "agent",
      attachments: [{ ref: "ref-1", fileName: "a.txt", mime: "text/plain", bytes: 1 }],
    });
    const draft = readV4ComposerDraft("/workspace", undefined, "session-1");
    expect(draft?.text).toHaveLength(MAX_V4_DRAFT_TEXT_BYTES);
    expect(draft?.attachments).toEqual([
      { ref: "ref-1", fileName: "a.txt", mime: "text/plain", bytes: 1 },
    ]);
  });

  it("P8: evicts the oldest session scopes beyond the storage bound", () => {
    const localStorage = storage();
    (globalThis as { window?: unknown }).window = { localStorage };
    for (let index = 0; index <= MAX_V4_DRAFT_SCOPES; index += 1) {
      persistV4ComposerDraft("/workspace", undefined, `session-${index}`, {
        text: String(index),
        mode: "agent",
      });
    }
    expect(readV4ComposerDraft("/workspace", undefined, "session-0")).toBeNull();
    expect(
      readV4ComposerDraft("/workspace", undefined, `session-${MAX_V4_DRAFT_SCOPES}`),
    ).not.toBeNull();
  });
});
