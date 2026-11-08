// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekStatusQueue, NekStoredAttachment } from "@zcode/shared/nek-protocol";
import { appendQueueItem, planQueueEdit, queuedInputAt, queueItemTargets } from "./queue.js";
import { useQueueBarController } from "./useQueueBarController.js";
import { useNekStatusStore } from "./store.js";
import { intlWrapper } from "./controllerTestUtils.js";
import {
  composerAttachmentScopeKey,
  readComposerAttachmentScope,
  restoreComposerSessionAttachments,
  useComposerAttachmentUploadStore,
} from "@/store/composerAttachmentUploadStore.js";

function file(id: number): NekStoredAttachment {
  return {
    path: `/home/test/.nek/agent/attachments/${id}/report.docx`,
    fileName: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 12,
    sha256: String(id).padStart(64, "0"),
  };
}

function queue(): NekStatusQueue {
  return {
    steering: ["same", "same", "other"],
    followUp: ["later"],
    inputs: {
      steering: [
        { text: "same", attachments: [file(1)] },
        { text: "same", attachments: [file(2)] },
        { text: "other" },
      ],
      followUp: [{ text: "later", attachments: [file(3)] }],
    },
  };
}

beforeEach(() => {
  useNekStatusStore.getState().reset();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});
afterEach(cleanup);

describe("attachment-bearing queue operations", () => {
  it("edits duplicate text without swapping files, and delete undo retains the original file", () => {
    const actual = queue();
    const target = queueItemTargets(actual)[1]!;
    const edited = planQueueEdit(actual, target, { type: "replace", text: "changed" });
    expect(edited.requeue.inputs?.steering[1]).toEqual({ text: "changed", attachments: [file(2)] });
    expect(edited.requeue.inputs?.steering[0]?.attachments).toEqual([file(1)]);
    expect(actual.steering[1]).toBe("same");
    const removed = planQueueEdit(actual, target, { type: "delete" });
    expect(removed.requeue.inputs?.steering.map((input) => input.text)).toEqual(["same", "other"]);
    const undone = appendQueueItem(
      removed.requeue,
      target.kind,
      target.text,
      queuedInputAt(actual, target),
    );
    expect(undone.inputs?.steering.at(-1)?.attachments).toEqual([file(2)]);
    expect(queueItemTargets(actual)[2]).toMatchObject({ text: "other", occurrence: 0 });
  });

  it("retrieves file chips into the exact remote session owner without re-uploading POSIX paths", async () => {
    const actual = queue();
    useNekStatusStore
      .getState()
      .consumeEvent(
        "session",
        { type: "queue_update", steering: actual.steering, followUp: actual.followUp },
        0,
      );
    const scope = composerAttachmentScopeKey("/project", "ssh://host-a/project", "session");
    const requeue = vi.fn(async () => {});
    const setText = vi.fn();
    const { result } = renderHook(
      () =>
        useQueueBarController({
          sessionKey: "session",
          clearQueue: async () => actual,
          requeue,
          getComposerText: () => "draft",
          setComposerText: setText,
          focusComposerAtEnd: vi.fn(),
          restoreComposerAttachments: (refs) =>
            restoreComposerSessionAttachments(scope, refs, true),
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await result.current.actions.retrieveAll.run());
    expect(setText).toHaveBeenCalledWith("same\n\nsame\n\nother\n\nlater\n\ndraft");
    expect(requeue).not.toHaveBeenCalled();
    const restored = readComposerAttachmentScope(scope);
    expect(restored).toHaveLength(3);
    expect(
      restored.every(
        (item) =>
          item.uploadStatus === "ready" &&
          item.referenceOwnership === "session" &&
          item.adopted &&
          !item.localPath,
      ),
    ).toBe(true);
    expect(restored[0]?.attachmentRef?.ref).toBe(file(1).path);
    const another = composerAttachmentScopeKey("/project", "ssh://host-b/project", "session");
    expect(readComposerAttachmentScope(another)).toHaveLength(0);
  });

  it("puts the full file-bearing queue back when the composer cannot accept every attachment", async () => {
    const actual = queue();
    useNekStatusStore
      .getState()
      .consumeEvent(
        "session",
        { type: "queue_update", steering: actual.steering, followUp: actual.followUp },
        0,
      );
    const scope = composerAttachmentScopeKey("/project", "ssh://host-a/project", "session");
    const existing = Array.from({ length: 8 }, (_, index) => ({
      ref: `/remote/existing-${index}`,
      fileName: "existing",
      mime: "text/plain",
      bytes: 1,
    }));
    expect(restoreComposerSessionAttachments(scope, existing)).toBe(true);
    const requeue = vi.fn(async () => {});
    const setText = vi.fn();
    const { result } = renderHook(
      () =>
        useQueueBarController({
          sessionKey: "session",
          clearQueue: async () => actual,
          requeue,
          getComposerText: () => "draft",
          setComposerText: setText,
          focusComposerAtEnd: vi.fn(),
          restoreComposerAttachments: (refs) =>
            restoreComposerSessionAttachments(scope, refs, true),
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await result.current.actions.retrieveAll.run());
    expect(requeue).toHaveBeenCalledWith(actual);
    expect(setText).not.toHaveBeenCalled();
    expect(readComposerAttachmentScope(scope)).toHaveLength(8);
    expect(result.current.actions.retrieveAll.error).toContain("8 attachments");
  });

  it.each([
    { sessionKey: "other-session", composerScopeKey: "ssh://host-a/project\0other-session" },
    { sessionKey: "session", composerScopeKey: "ssh://host-b/project\0session" },
  ])("a late retrieval cannot cross session/remote scope $composerScopeKey", async (nextScope) => {
    const actual = queue();
    useNekStatusStore
      .getState()
      .consumeEvent(
        "session",
        { type: "queue_update", steering: actual.steering, followUp: actual.followUp },
        0,
      );
    let release!: (value: NekStatusQueue) => void;
    const reply = new Promise<NekStatusQueue>((resolve) => {
      release = resolve;
    });
    const requeue = vi.fn(async () => {});
    const setText = vi.fn();
    const restore = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ sessionKey, composerScopeKey }) =>
        useQueueBarController({
          sessionKey,
          composerScopeKey,
          clearQueue: () => reply,
          requeue,
          getComposerText: () => "new draft",
          setComposerText: setText,
          restoreComposerAttachments: restore,
          focusComposerAtEnd: vi.fn(),
        }),
      {
        initialProps: { sessionKey: "session", composerScopeKey: "ssh://host-a/project\0session" },
        wrapper: intlWrapper,
      },
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.actions.retrieveAll.run();
    });
    rerender(nextScope);
    await act(async () => {
      release(actual);
      await pending;
    });
    expect(requeue).toHaveBeenCalledWith(actual);
    expect(setText).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("editing one plain item preserves attachments on every other requeued item", async () => {
    const actual = queue();
    useNekStatusStore
      .getState()
      .consumeEvent(
        "session",
        { type: "queue_update", steering: actual.steering, followUp: actual.followUp },
        0,
      );
    const requeue = vi.fn(async () => {});
    const { result } = renderHook(
      () =>
        useQueueBarController({
          sessionKey: "session",
          clearQueue: async () => actual,
          requeue,
          getComposerText: () => "",
          setComposerText: vi.fn(),
          focusComposerAtEnd: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await result.current.view.items[2]!.edit.run());
    await act(async () => await result.current.commitEdit("plain changed"));
    expect(requeue).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: {
          steering: [
            { text: "same", attachments: [file(1)] },
            { text: "same", attachments: [file(2)] },
            { text: "plain changed" },
          ],
          followUp: [{ text: "later", attachments: [file(3)] }],
        },
      }),
    );
  });
});
