// @vitest-environment happy-dom
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSubagentHistoryConversation,
  type SubagentHistoryConversation,
} from "./subagentHistoryConversation.js";
import { childPreview, scope, settleChild } from "./subagentHistory.testFixtures.js";
import { observationSource } from "./historyObservation.testFixtures.js";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";

const owners: SubagentHistoryConversation[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
});
async function setup(source = observationSource()) {
  const owner = createSubagentHistoryConversation(source.service, scope);
  owners.push(owner);
  await settleChild();
  return { source, owner };
}

it("HO3: guarded compatible append changes the real prefix revision while preserving older rows/cursors", async () => {
  const { owner, source } = await setup();
  await owner.loadOlder();
  const before = owner.getState().data!;
  const proof = before.history.observationCursor;
  source.append();
  source.watermark.atSeq = 2;
  source.watermark.atRevision = 2;
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  const after = owner.getState().data!;
  expect(after).toMatchObject({ atSeq: 2, atRevision: 2 });
  expect(source.service.getSubagentConversation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: scope.parentSessionId,
      id: scope.childSessionId,
      observationCursor: proof,
    }),
  );
  expect(after.rows).toBe(before.rows);
  expect(after.history.branchRevision).not.toBe(before.history.branchRevision);
  expect(after.history).toMatchObject({
    totalTurns: 71,
    olderCursor: before.history.olderCursor,
    newerCursor: before.history.newerCursor,
  });
  source.append();
  await owner.loadOlder();
  expect(source.service.conversationHistoryPageV4).toHaveBeenLastCalledWith(
    expect.objectContaining({
      observationCursor: after.history.observationCursor,
      beforeCursor: before.history.olderCursor,
    }),
  );
  expect(owner.getState().error).toBeNull();
  expect(owner.getState().data!.history.totalTurns).toBe(72);
});

it.each([0, 70])(
  "HO3: latest polling from %s turns follows guarded append, not a constant branch hash",
  async (initial) => {
    const { owner, source } = await setup(observationSource(initial));
    const before = owner.getState().data!;
    source.append(5);
    await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
    expect(owner.getState().error).toBeNull();
    expect(owner.getState().data!.history.branchRevision).not.toBe(before.history.branchRevision);
    expect(owner.getState().data!.rows[0]?.turnId).toBe(`turn:${Math.max(0, initial + 5 - 20)}`);
    expect(source.service.getSubagentConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({ observationCursor: before.history.observationCursor }),
    );
  },
);

it("HO4: failed source proof retains rows and exact retry; only explicit latest drops the prior proof", async () => {
  const { owner, source } = await setup();
  await owner.loadOlder();
  const before = owner.getState().data!;
  source.rewrite();
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toContain("STALE_CURSOR");
  await vi.advanceTimersByTimeAsync(5 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(source.service.getSubagentConversation).toHaveBeenCalledTimes(2);
  await owner.retry();
  expect(source.service.getSubagentConversation).toHaveBeenCalledTimes(3);
  expect(source.service.getSubagentConversation).toHaveBeenLastCalledWith(
    expect.objectContaining({ observationCursor: before.history.observationCursor }),
  );
  expect(owner.getState().data).toBe(before);
  await owner.loadLatest();
  await settleChild();
  expect(
    source.service.conversationHistoryPageV4.mock.calls.at(-1)?.[0].observationCursor,
  ).toBeUndefined();
  expect(owner.getState().error).toBeNull();
  expect(owner.getState().data!.history.branchRevision).not.toBe(before.history.branchRevision);
});

it("HO3/HO4: a bare changed hash with no prior source proof is not compatible append", async () => {
  const source = observationSource();
  source.service.getSubagentConversation.mockImplementationOnce(async (params) => {
    const page = source.page(params);
    return {
      ...childPreview("running", {
        ...page,
        history: { ...page.history, observationCursor: undefined },
      }),
      ...source.watermark,
    };
  });
  const { owner } = await setup(source);
  const before = owner.getState().data!;
  source.append();
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toContain("without observation proof");
  expect(source.service.conversationHistoryPageV4).not.toHaveBeenCalled();
});

it("HO4: a guarded reply missing the returned proof fails even if the backend returned a new hash", async () => {
  const { source, owner } = await setup();
  const before = owner.getState().data!;
  source.append();
  const page = source.page({});
  source.service.getSubagentConversation.mockResolvedValueOnce({
    ...childPreview("running", {
      ...page,
      history: { ...page.history, observationCursor: undefined },
    }),
    ...source.watermark,
  });
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toContain("omitted its observation proof");
});

it("HO5: child directory reads carry the last proof and remain valid after append", async () => {
  const { source, owner } = await setup(observationSource(70, "completed"));
  const proof = owner.getState().data!.history.observationCursor;
  source.append();
  await owner.getState().historyControls!.directory.reload();
  expect(source.service.conversationHistoryDirectoryV4).toHaveBeenLastCalledWith(
    expect.objectContaining({ observationCursor: proof }),
  );
  expect(owner.getState().error).toBeNull();
});

it.each(["epoch", "seq", "revision"])(
  "HO5: valid prefix proof does not weaken child %s fencing",
  async (field) => {
    const { source, owner } = await setup();
    const before = owner.getState().data!;
    source.append();
    if (field === "epoch") source.watermark.atLogEpoch = "other-runtime";
    if (field === "seq") source.watermark.atSeq = 0;
    if (field === "revision") source.watermark.atRevision = 0;
    await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
    expect(owner.getState().data).toBe(before);
    expect(owner.getState().error).toContain("watermark changed");
  },
);
