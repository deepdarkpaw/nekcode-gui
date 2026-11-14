import { afterEach, expect, it } from "vitest";
import type { V4ConversationHistoryPageResult } from "@zcode/shared/zcode-protocol-v4";
import {
  createSubagentHistoryConversation,
  type SubagentHistoryConversation,
} from "./subagentHistoryConversation.js";
import {
  childDirectory,
  childPage,
  childPreview,
  childRow,
  childService,
  deferred,
  scope,
  settleChild,
  watermark,
} from "./subagentHistory.testFixtures.js";

const owners: SubagentHistoryConversation[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
});
async function setup(preview = childPreview()) {
  const fake = childService(preview);
  const owner = createSubagentHistoryConversation(fake.service, scope);
  owners.push(owner);
  await settleChild();
  return { ...fake, owner };
}
const target = {
  workspacePath: scope.workspacePath,
  workspaceIdentity: scope.workspaceIdentity,
  remoteSessionId: scope.remoteSessionId,
  sessionId: scope.parentSessionId,
  subagentId: scope.childSessionId,
};

it("CH1: initial latest20 uses trusted parent authorization, never child resume or paths", async () => {
  const { owner, service } = await setup();
  expect(service.getSubagentConversation).toHaveBeenCalledExactlyOnceWith({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: scope.remoteSessionId,
    sessionId: scope.parentSessionId,
    id: scope.childSessionId,
    turnLimit: 20,
  });
  expect(owner.getState().data?.rows).toHaveLength(20);
  expect(owner.getState().historyControls?.history.totalTurns).toBe(70);
  expect(service.conversationHistoryPageV4).not.toHaveBeenCalled();
});

it("CH2: explicit older/newer/around/latest are scoped and single-flight", async () => {
  const { owner, service } = await setup();
  const pending = deferred<V4ConversationHistoryPageResult>();
  service.conversationHistoryPageV4.mockImplementationOnce(() => pending.promise);
  const first = owner.loadOlder();
  await owner.loadOlder();
  expect(service.conversationHistoryPageV4).toHaveBeenCalledExactlyOnceWith({
    ...target,
    beforeCursor: "before:50",
    turnLimit: 20,
  });
  pending.resolve(childPage(30, 50));
  await first;
  expect(owner.getState().data?.rows).toHaveLength(40);
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(10, 30));
  await owner.loadAround("entry:20");
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadNewer();
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({
    ...target,
    afterCursor: "after:30",
    turnLimit: 20,
  });
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage());
  await owner.loadLatest();
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({ ...target, turnLimit: 20 });
  expect(owner.getState().data?.rows).toHaveLength(20);
});

it("CH2: six-page retention evicts whole pages with valid forward/backward cursors", async () => {
  const { owner, service } = await setup(childPreview("completed", childPage(180, 200, 200)));
  for (let start = 160; start >= 0; start -= 20) {
    service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(start, start + 20, 200));
    await owner.loadOlder();
  }
  expect(owner.getState().data?.rows).toHaveLength(120);
  expect(owner.getState().data?.history).toMatchObject({
    hasOlder: false,
    hasNewer: true,
    newerCursor: "after:120",
    totalTurns: 200,
  });
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(120, 140, 200));
  await owner.loadNewer();
  expect(owner.getState().data?.history.olderCursor).toBe("before:20");
});

it("CH2/CH6: runtime retirement discards an old body read and exact explicit latest renews owner", async () => {
  const { owner, service, runtime } = await setup();
  const pending = deferred<V4ConversationHistoryPageResult>();
  service.conversationHistoryPageV4.mockImplementationOnce(() => pending.promise);
  const request = owner.loadOlder().catch(() => undefined);
  const before = owner.getState().data;
  runtime("unrelated");
  expect(owner.getState().error).toBeNull();
  runtime();
  pending.resolve(childPage(30, 50));
  await request;
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toContain("runtime changed");
  service.conversationHistoryPageV4.mockResolvedValueOnce({ ...childPage(), atLogEpoch: "next" });
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce({
    ...childDirectory(),
    atLogEpoch: "next",
  });
  await owner.retry();
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({ ...target, turnLimit: 20 });
  expect(owner.getState().error).toBeNull();
});

it("CH2/CH6: epoch and branch mismatches leave current body visible", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadOlder();
  const before = owner.getState().data;
  service.conversationHistoryPageV4.mockResolvedValueOnce({
    ...childPage(10, 30),
    atLogEpoch: "other",
  });
  await expect(owner.loadOlder()).rejects.toThrow("watermark changed");
  expect(owner.getState().data).toBe(before);
  const page = childPage(10, 30);
  page.history.branchRevision = "other";
  service.conversationHistoryPageV4.mockResolvedValueOnce(page);
  await expect(owner.loadOlder()).rejects.toThrow("branch changed");
  expect(owner.getState().data).toBe(before);
});

it("CH4: one explicit turn slice merges stable identities and continuation without draining", async () => {
  const { owner, service } = await setup();
  await owner.loadTurn("turn:60", "slice:1");
  expect(service.conversationHistoryTurnV4).toHaveBeenCalledExactlyOnceWith({
    ...target,
    turnId: "turn:60",
    cursor: "slice:1",
  });
  await owner.loadTurn("turn:60", "slice:1");
  expect(owner.getState().data?.rows.filter((row) => row.turnId === "turn:60")).toHaveLength(1);
  expect(
    owner.getState().data?.history.turns.find((turn) => turn.turnId === "turn:60")
      ?.continuationCursor,
  ).toBe("slice:2");
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(1);
});

it("CH4/CH6: explicit bounded content read is not retained, and retry preserves ref/offset/limit", async () => {
  const { owner, service } = await setup();
  const before = owner.getState().data;
  service.conversationHistoryContentV4.mockRejectedValueOnce(new Error("piece failed"));
  const options = { ref: "ref", offset: 3, limit: 10 };
  await expect(owner.readContent(options)).rejects.toThrow("piece failed");
  expect(owner.getState().error).toBe("piece failed");
  await owner.retry();
  expect(service.conversationHistoryContentV4).toHaveBeenLastCalledWith({ ...target, ...options });
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toBeNull();
  expect(service.conversationHistoryPageV4).not.toHaveBeenCalled();
});

it("CH4/CH6: directory search/loadMore/retry stays metadata-only and keeps the failed cursor", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 20, true));
  owner.setQuery("search");
  await settleChild();
  const before = owner.getState().data;
  service.conversationHistoryDirectoryV4.mockRejectedValueOnce(new Error("directory failed"));
  await owner.getState().historyControls!.directory.loadMore();
  expect(owner.getState().error).toBe("directory failed");
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(20));
  await owner.retry();
  expect(service.conversationHistoryDirectoryV4).toHaveBeenLastCalledWith({
    ...target,
    query: "search",
    direction: "newest",
    limit: 20,
    cursor: "dir:20",
  });
  expect(owner.getState().historyControls!.directory.items).toHaveLength(40);
  expect(owner.getState().error).toBeNull();
  expect(owner.getState().data).toBe(before);
  expect(service.conversationHistoryPageV4).not.toHaveBeenCalled();
});

it("CH4/CH6: oldest lookup is one atomic user intent and retries navigation, not lookup-only success", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryDirectoryV4.mockRejectedValueOnce(new Error("oldest failed"));
  expect(await owner.loadOldest()).toBeNull();
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 1));
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(0, 20));
  expect(await owner.retry()).toBe("turn:0");
  expect(service.conversationHistoryDirectoryV4).toHaveBeenCalledWith({
    ...target,
    direction: "oldest",
    limit: 1,
  });
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({
    ...target,
    aroundEntryId: "entry:0",
    turnLimit: 20,
  });
  expect(owner.getState().data?.rows[0]?.turnId).toBe("turn:0");
});

it("CH6: nonadvancing and empty pages fail visibly, and older retry repeats the exact intent", async () => {
  const { owner, service } = await setup();
  const before = owner.getState().data;
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage());
  await expect(owner.loadOlder()).rejects.toThrow("did not advance");
  expect(owner.getState().data).toBe(before);
  const empty = childPage(30, 50);
  empty.rows = [];
  service.conversationHistoryPageV4.mockResolvedValueOnce(empty);
  await owner.retry();
  expect(owner.getState().error).toContain("invalid bounded page");
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.retry();
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({
    ...target,
    beforeCursor: "before:50",
    turnLimit: 20,
  });
  expect(owner.getState().data?.rows).toHaveLength(40);
  expect(owner.getState().error).toBeNull();
});

it("CH4/CH6: nonadvancing directory responses retain an exact loadMore retry, not an inert error", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 20, true));
  owner.setQuery("search");
  await settleChild();
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 20, true));
  await owner.getState().historyControls!.directory.loadMore();
  expect(owner.getState().error).toContain("did not advance");
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(20));
  await owner.retry();
  expect(service.conversationHistoryDirectoryV4).toHaveBeenLastCalledWith({
    ...target,
    query: "search",
    direction: "newest",
    cursor: "dir:20",
    limit: 20,
  });
  expect(owner.getState().historyControls!.directory.items).toHaveLength(40);
  expect(owner.getState().error).toBeNull();
});

it("CH4/CH6: turn failure cannot pretend a missing continuation part completed", async () => {
  const { owner, service } = await setup();
  const before = owner.getState().data;
  const turn = { turnId: "turn:60", userEntryId: "entry:60", position: 60, preview: "question" };
  service.conversationHistoryTurnV4.mockResolvedValueOnce({
    ...watermark,
    turn,
    rows: [childRow(60)],
    hasMore: true,
    continuationCursor: "slice:1",
  });
  await expect(owner.loadTurn("turn:60", "slice:1")).rejects.toThrow("did not advance");
  expect(owner.getState().data).toBe(before);
  service.conversationHistoryTurnV4.mockResolvedValueOnce({
    ...watermark,
    turn,
    rows: [],
    hasMore: false,
  });
  await owner.retry();
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toContain("omitted rows");
  service.conversationHistoryTurnV4.mockResolvedValueOnce({
    ...watermark,
    turn,
    rows: [childRow(60, "hydrated")],
    hasMore: false,
  });
  await owner.retry();
  expect(service.conversationHistoryTurnV4).toHaveBeenLastCalledWith({
    ...target,
    turnId: "turn:60",
    cursor: "slice:1",
  });
  expect(owner.getState().error).toBeNull();
});

it("CH6: malformed initial empty body is visible failure and retries the initial latest20", async () => {
  const invalid = childPreview();
  invalid.rows = [];
  invalid.history.turns = [];
  const { owner, service } = await setup(invalid);
  expect(owner.getState().data).toBeUndefined();
  expect(owner.getState().error).toContain("invalid bounded page");
  service.getSubagentConversation.mockResolvedValueOnce(childPreview());
  await owner.retry();
  expect(owner.getState().data?.rows).toHaveLength(20);
  expect(owner.getState().error).toBeNull();
});

it("CH4/CH6: content admission caps concurrency and chunk size without losing the exact failed piece", async () => {
  const { owner, service } = await setup();
  const pending = Array.from({ length: 4 }, () =>
    deferred<Awaited<ReturnType<typeof service.conversationHistoryContentV4>>>(),
  );
  for (const item of pending)
    service.conversationHistoryContentV4.mockImplementationOnce(() => item.promise);
  const reads = pending.map((_, offset) =>
    owner.readContent({ ref: "ref", offset, limit: 1000000 }),
  );
  await expect(owner.readContent({ ref: "ref", offset: 99, limit: 1000000 })).rejects.toThrow(
    "unavailable or busy",
  );
  expect(service.conversationHistoryContentV4).toHaveBeenCalledTimes(4);
  expect(service.conversationHistoryContentV4).toHaveBeenLastCalledWith({
    ...target,
    ref: "ref",
    offset: 3,
    limit: 64 * 1024,
  });
  for (let n = 0; n < pending.length; n++)
    pending[n]!.resolve({
      ...watermark,
      ref: "ref",
      offset: n,
      totalBytes: 100,
      encoding: "base64",
      data: "YQ==",
      mediaType: "application/json",
    });
  await Promise.all(reads);
  expect(owner.getState().error).toContain("unavailable or busy");
  await owner.retry();
  expect(service.conversationHistoryContentV4).toHaveBeenLastCalledWith({
    ...target,
    ref: "ref",
    offset: 99,
    limit: 64 * 1024,
  });
  expect(owner.getState().error).toBeNull();
});

it("CH6: successful body navigation does not make a retained directory error's retry inert", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadOlder();
  await settleChild();
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 20, true));
  owner.setQuery("search");
  await settleChild();
  service.conversationHistoryDirectoryV4.mockRejectedValueOnce(
    new Error("directory reload failed"),
  );
  await owner.getState().historyControls!.directory.reload();
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadAround("entry:40");
  expect(owner.getState().error).toBe("directory reload failed");
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce(childDirectory(0, 20, true));
  await owner.retry();
  expect(service.conversationHistoryDirectoryV4).toHaveBeenLastCalledWith({
    ...target,
    query: "search",
    direction: "newest",
    limit: 20,
  });
  expect(owner.getState().error).toBeNull();
});

it("CH2/CH4: 16MB turn-piece budget keeps requested slice and explicit omission metadata", async () => {
  const initial = childPage(0, 1, 1);
  initial.rows = [childRow(0, "a".repeat(9 * 1024 * 1024))];
  const { owner, service } = await setup(childPreview("completed", initial));
  service.conversationHistoryTurnV4.mockResolvedValueOnce({
    ...watermark,
    rows: [{ ...childRow(0, "b".repeat(9 * 1024 * 1024)), entityId: "part:2", rowId: 2 }],
    turn: initial.history.turns[0]!,
    hasMore: true,
    continuationCursor: "next",
  });
  await owner.loadTurn("turn:0", "slice:1");
  expect(owner.getState().data?.rows).toHaveLength(1);
  expect(owner.getState().data?.rows[0]?.entityId).toBe("part:2");
  expect(owner.getState().historyControls?.truncatedTurns).toEqual([
    { turnId: "turn:0", reason: "budget" },
  ]);
});
