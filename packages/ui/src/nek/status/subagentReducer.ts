import type { NekState, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import {
  finishedNotification,
  TERMINAL_SUBAGENT_STATUSES,
  trimSubagents,
  updateTimestamp,
} from "./reducerUtils.js";
import type {
  NekSessionStatus,
  NekStatusSubagent,
  SubagentFinishedEvent,
} from "./types.js";

function cloneSubagent(record: NekSubagentRecord): NekStatusSubagent {
  return { ...record };
}

export function upsertSubagent(
  state: NekSessionStatus,
  sessionKey: string,
  record: NekSubagentRecord,
  now: number,
): { state: NekSessionStatus; event?: SubagentFinishedEvent } {
  const previous = state.subagents.byId[record.id];
  if (
    previous &&
    TERMINAL_SUBAGENT_STATUSES.has(previous.status) &&
    previous.status !== record.status
  ) {
    return { state };
  }
  const next: NekStatusSubagent = {
    ...cloneSubagent(record),
    ...(record.status === "running" && previous?.stopRequested
      ? { stopRequested: true, stopRequestedAt: previous.stopRequestedAt }
      : {}),
  };
  const order = previous ? state.subagents.order : [...state.subagents.order, record.id];
  const trimmed = trimSubagents(order, { ...state.subagents.byId, [record.id]: next });
  const updated = updateTimestamp({ ...state, subagents: trimmed }, now);
  return finishedNotification(updated, sessionKey, previous, next);
}

export function mergeStateSubagents(
  state: NekSessionStatus,
  sessionKey: string,
  snapshot: NekState["subagents"],
  now: number,
): { state: NekSessionStatus; events: SubagentFinishedEvent[] } {
  const incoming = new Map(snapshot.map((record) => [record.id, record]));
  const nextById: Record<string, NekStatusSubagent> = {};
  const nextOrder: string[] = [];
  const events: SubagentFinishedEvent[] = [];
  let currentState = state;
  for (const id of state.subagents.order) {
    const previous = state.subagents.byId[id];
    const incomingRecord = incoming.get(id);
    let next = incomingRecord ? cloneSubagent(incomingRecord) : previous;
    if (!incomingRecord && previous?.status === "running") {
      next = { ...previous, status: "aborted", endedAt: now, stopRequested: undefined };
    }
    if (!next) continue;
    if (next.status === "running" && previous?.stopRequested) {
      next = { ...next, stopRequested: true, stopRequestedAt: previous.stopRequestedAt };
    }
    nextById[id] = next;
    nextOrder.push(id);
    const result = finishedNotification(
      { ...currentState, subagents: { order: nextOrder, byId: nextById } },
      sessionKey,
      previous,
      next,
    );
    currentState = result.state;
    if (result.event) events.push(result.event);
  }
  for (const record of snapshot) {
    if (nextById[record.id]) continue;
    nextById[record.id] = cloneSubagent(record);
    nextOrder.push(record.id);
  }
  return {
    state: updateTimestamp(
      { ...currentState, subagents: trimSubagents(nextOrder, nextById) },
      now,
    ),
    events,
  };
}

export function abortRunningSubagents(
  state: NekSessionStatus,
  sessionKey: string,
  now: number,
): { state: NekSessionStatus; events: SubagentFinishedEvent[] } {
  let nextState = state;
  const events: SubagentFinishedEvent[] = [];
  for (const id of state.subagents.order) {
    const previous = nextState.subagents.byId[id];
    if (!previous || previous.status !== "running") continue;
    const nextRecord: NekStatusSubagent = {
      ...previous,
      status: "aborted",
      endedAt: now,
      stopRequested: undefined,
      stopRequestedAt: undefined,
    };
    const result = finishedNotification(
      {
        ...nextState,
        subagents: {
          ...nextState.subagents,
          byId: { ...nextState.subagents.byId, [id]: nextRecord },
        },
      },
      sessionKey,
      previous,
      nextRecord,
    );
    nextState = result.state;
    if (result.event) events.push(result.event);
  }
  return { state: nextState, events };
}
EOF