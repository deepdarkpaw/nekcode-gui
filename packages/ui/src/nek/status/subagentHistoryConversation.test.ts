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
  childService,
  deferred,
  scope,
  settleChild,
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
