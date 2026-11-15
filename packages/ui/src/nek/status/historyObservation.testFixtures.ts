import { vi, type Mock } from "vitest";
import type {
  ConversationHistoryObservation,
  V4ConversationHistoryPageResult,
  ConversationHistoryPageOptions,
  ConversationHistoryReadOptions,
  ConversationHistoryWatermark,
} from "@zcode/shared/zcode-protocol-v4";
import type { SubagentHistoryService } from "./subagentHistoryTypes.js";
import { childDirectory, childPage, childPreview } from "./subagentHistory.testFixtures.js";

type SourceService = {
  [K in keyof Omit<SubagentHistoryService, "onAgentRuntimeLifecycle">]: Mock<
    SubagentHistoryService[K]
  >;
};
interface ObservationSource {
  service: SourceService;
  page(options: ConversationHistoryPageOptions): V4ConversationHistoryPageResult;
  identity(): Required<ConversationHistoryObservation>;
  append(count?: number): void;
  rewrite(): void;
  setStatus(status: "running" | "completed"): void;
  watermark: ConversationHistoryWatermark;
}

/** Test source authority: revisions change on every append; only an issued intact prefix is compatible. */
export function observationSource(
  initial = 70,
  initialStatus: "running" | "completed" = "running",
): ObservationSource {
  let size = initial;
  let rewrite = 0;
  let status = initialStatus;
  const observations = new Map<string, { size: number; rewrite: number }>();
  const watermark: ConversationHistoryWatermark = { atSeq: 1, atRevision: 1, atLogEpoch: "epoch" };
  function guard(options: ConversationHistoryReadOptions) {
    if (!options.observationCursor) return;
    const prefix = observations.get(options.observationCursor);
    if (!prefix || prefix.rewrite !== rewrite || prefix.size > size)
      throw new Error("STALE_CURSOR: observed prefix changed");
  }
  function identity() {
    const observationCursor = `opaque-observation:${rewrite}:${size}`;
    observations.set(observationCursor, { rewrite, size });
    return { branchRevision: `observed-prefix-hash:${rewrite}:${size}`, observationCursor };
  }
  function page(options: ConversationHistoryPageOptions) {
    guard(options);
    const limit = options.turnLimit ?? 20;
    let end = options.beforeCursor ? Number(options.beforeCursor.split(":")[1]) : size;
    let start = options.afterCursor
      ? Number(options.afterCursor.split(":")[1])
      : Math.max(0, end - limit);
    if (options.aroundEntryId)
      start = Math.max(0, Number(options.aroundEntryId.split(":")[1]) - 10);
    if (options.afterCursor || options.aroundEntryId) end = Math.min(size, start + limit);
    const result = childPage(start, end, size);
    const observation = identity();
    return {
      ...result,
      ...watermark,
      ...observation,
      history: { ...result.history, ...observation },
    };
  }
  const service = {
    getSubagentConversation: vi.fn<SubagentHistoryService["getSubagentConversation"]>(
      async (params) => ({ ...childPreview(status, page(params)), ...watermark }),
    ),
    conversationHistoryPageV4: vi.fn<SubagentHistoryService["conversationHistoryPageV4"]>(
      async (params) => page(params),
    ),
    conversationHistoryDirectoryV4: vi.fn<SubagentHistoryService["conversationHistoryDirectoryV4"]>(
      async (params) => {
        guard(params);
        const count = Math.min(size, params.limit ?? 20);
        const start = params.cursor
          ? Number(params.cursor.split(":")[1])
          : params.direction === "oldest"
            ? 0
            : Math.max(0, size - count);
        return {
          ...childDirectory(start, count, false),
          totalTurns: size,
          ...watermark,
          ...identity(),
        };
      },
    ),
    onAgentRuntimeRestarted: vi.fn<SubagentHistoryService["onAgentRuntimeRestarted"]>(() => ({
      dispose() {},
    })),
  };
  return {
    service,
    page,
    identity,
    append: (count = 1) => {
      size += count;
    },
    rewrite: () => {
      rewrite++;
    },
    setStatus: (next: typeof status) => {
      status = next;
    },
    watermark,
  };
}
