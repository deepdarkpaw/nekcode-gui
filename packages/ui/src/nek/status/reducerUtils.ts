import type { NekSubagentRecord } from "@zcode/shared/nek-protocol";
import {
  NEK_STATUS_MAX_FINISHED_IDS,
  NEK_STATUS_MAX_NOTICES,
  NEK_STATUS_MAX_SUBAGENTS,
  type NekSessionStatus,
  type NekStatusNotice,
  type NekStatusSubagent,
  type SubagentFinishedEvent,
} from "./types.js";

export const TERMINAL_SUBAGENT_STATUSES = new Set<NekSubagentRecord["status"]>([
  "completed",
  "errored",
  "aborted",
]);

export function updateTimestamp(state: NekSessionStatus, now: number): NekSessionStatus {
  return state.lastUpdatedAt === now ? state : { ...state, lastUpdatedAt: now };
}

export function pushNotice(
  state: NekSessionStatus,
  notice: NekStatusNotice,
): NekSessionStatus {
  return {
    ...state,
    notices: [...state.notices, notice].slice(-NEK_STATUS_MAX_NOTICES),
  };
}

export function makeNotice(
  sessionKey: string,
  id: string,
  now: number,
): NekStatusNotice {
  return { sessionKey, id, createdAt: now };
}

export function trimSubagents(
  order: readonly string[],
  byId: Readonly<Record<string, NekStatusSubagent>>,
): { order: string[]; byId: Record<string, NekStatusSubagent> } {
  const nextOrder = [...order];
  const nextById = { ...byId };
  while (nextOrder.length > NEK_STATUS_MAX_SUBAGENTS) {
    const removableIndex = nextOrder.findIndex(
      (id) =>
        nextById[id] !== undefined && TERMINAL_SUBAGENT_STATUSES.has(nextById[id].status),
    );
    if (removableIndex < 0) break;
    const [removed] = nextOrder.splice(removableIndex, 1);
    if (removed !== undefined) delete nextById[removed];
  }
  return { order: nextOrder, byId: nextById };
}

export function finishedNotification(
  state: NekSessionStatus,
  sessionKey: string,
  previous: NekStatusSubagent | undefined,
  next: NekStatusSubagent,
): { state: NekSessionStatus; event?: SubagentFinishedEvent } {
  if (
    previous?.status !== "running" ||
    !TERMINAL_SUBAGENT_STATUSES.has(next.status) ||
    state.finishedSubagentIds.includes(next.id)
  ) {
    return { state };
  }
  const event: SubagentFinishedEvent = {
    type: "subagentFinished",
    sessionKey,
    id: next.id,
    status: next.status,
    description: next.description,
    background: next.background,
  };
  return {
    state: {
      ...state,
      finishedSubagentIds: [...state.finishedSubagentIds, next.id].slice(
        -NEK_STATUS_MAX_FINISHED_IDS,
      ),
    },
    event,
  };
}
EOF