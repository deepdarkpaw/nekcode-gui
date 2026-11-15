import { expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "./agentConversationTransport.js";
import { ReplaceableConversationTransport } from "./replaceableConversationTransport.js";

vi.mock("@/v4/agentV4ConnectionHandshake.js", () => ({
  ensureAgentV4ConnectionHandshake: vi.fn(async () => ({})),
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
function adapter() {
  const service = {
    conversationHistoryPageV4: vi.fn(async () => ({ marker: "page" })),
    conversationHistoryDirectoryV4: vi.fn(async () => ({ marker: "directory" })),
  };
  const transport = createAgentConversationTransport(
    service as unknown as Parameters<typeof createAgentConversationTransport>[0],
    { workspacePath: "/trusted", workspaceIdentity: "ssh:trusted" },
  );
  return { service, transport };
}

it("RH8: real history adapter crosses the existing trusted service contract with parent and subagent identity", async () => {
  const { transport, service } = adapter();
  const scope = { sessionId: "parent", subagentId: "child" };
  await expect(
    transport.historyPage({ ...scope, beforeCursor: "before", turnLimit: 20 }),
  ).resolves.toEqual({ marker: "page" });
  await transport.historyDirectory({ ...scope, query: "search", direction: "oldest", limit: 100 });
  const target = { ...scope, workspacePath: "/trusted", workspaceIdentity: "ssh:trusted" };
  expect(service.conversationHistoryPageV4).toHaveBeenCalledWith({
    ...target,
    beforeCursor: "before",
    turnLimit: 20,
  });
  expect(service.conversationHistoryDirectoryV4).toHaveBeenCalledWith({
    ...target,
    query: "search",
    direction: "oldest",
    limit: 100,
  });
});

it("RH2/RH8: replaceable transport rejects a late history result from a retired connection", async () => {
  const first = adapter();
  const second = adapter();
  let resolve!: (value: { marker: string }) => void;
  first.service.conversationHistoryPageV4.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const transport = new ReplaceableConversationTransport(first.transport);
  const request = transport.historyPage({ sessionId: "parent" });
  await vi.waitFor(() => expect(first.service.conversationHistoryPageV4).toHaveBeenCalledTimes(1));
  transport.replace(second.transport);
  transport.replace(first.transport);
  resolve({ marker: "old" });
  await expect(request).rejects.toThrow("transport was replaced");
});

it("RH8/RH9: replaceable transport forwards all history methods to the latest real adapter", async () => {
  const first = adapter();
  const second = adapter();
  const transport = new ReplaceableConversationTransport(first.transport);
  transport.replace(second.transport);
  await transport.historyPage({ sessionId: "parent" });
  await transport.historyDirectory({ sessionId: "parent" });
  for (const method of [
    "conversationHistoryPageV4",
    "conversationHistoryDirectoryV4",
  ] as const) {
    expect(first.service[method]).not.toHaveBeenCalled();
    expect(second.service[method]).toHaveBeenCalledTimes(1);
  }
});
