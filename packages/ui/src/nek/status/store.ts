import { create } from "zustand";
import type { NekSessionStats } from "@zcode/shared/nek-protocol";
import {
  advanceNekStatus,
  clearStopRequested,
  createNekSessionStatus,
  markStopRequested,
  reduceNekStatusEvent,
} from "./reducer.js";
import type {
  NekSessionStatus,
  NekStatusEvent,
  NekStatusEventOutput,
  NekStatusStoreState,
} from "./types.js";
import { NEK_STATUS_MAX_SESSIONS, NEK_STATUS_STATS_THROTTLE_MS } from "./types.js";

const EMPTY_SESSIONS: Record<string, NekSessionStatus> = {};

function touchSession(
  sessions: Readonly<Record<string, NekSessionStatus>>,
  sessionKey: string,
  status: NekSessionStatus,
  currentSessionKey: string | null,
): Record<string, NekSessionStatus> {
  const entries = Object.entries(sessions).filter(([key]) => key !== sessionKey);
  entries.push([sessionKey, status]);
  while (entries.length > NEK_STATUS_MAX_SESSIONS) {
    const removableIndex = entries.findIndex(([key]) => key !== currentSessionKey);
    if (removableIndex < 0) break;
    entries.splice(removableIndex, 1);
  }
  return Object.fromEntries(entries);
}

function getOrCreate(
  sessions: Readonly<Record<string, NekSessionStatus>>,
  sessionKey: string,
  now: number,
): NekSessionStatus {
  return sessions[sessionKey] ?? createNekSessionStatus(now);
}

export interface NekStatusStoreStateWithSession extends NekStatusStoreState {
  currentSessionKey: string | null;
  setCurrentSession: (sessionKey: string | null, now?: number) => void;
}

export const useNekStatusStore = create<NekStatusStoreStateWithSession>((set) => ({
  sessions: EMPTY_SESSIONS,
  currentSessionKey: null,
  consumeEvent: (
    sessionKey: string,
    event: NekStatusEvent,
    now = Date.now(),
  ): NekStatusEventOutput => {
    let output: NekStatusEventOutput = { needsStatsRefresh: false };
    set((state) => {
      const current = getOrCreate(state.sessions, sessionKey, now);
      const reduced = reduceNekStatusEvent(current, sessionKey, event, now);
      output = reduced.output;
      return {
        sessions: touchSession(state.sessions, sessionKey, reduced.state, state.currentSessionKey),
      };
    });
    return output;
  },
  setStats: (sessionKey: string, stats: NekSessionStats, now = Date.now()) => {
    set((state) => {
      const current = getOrCreate(state.sessions, sessionKey, now);
      return {
        sessions: touchSession(
          state.sessions,
          sessionKey,
          {
            ...current,
            stats,
            statsStale: false,
            statsRefreshPending: false,
            lastUpdatedAt: now,
          },
          state.currentSessionKey,
        ),
      };
    });
  },
  markStatsFresh: (sessionKey: string, now = Date.now()) => {
    set((state) => {
      const current = state.sessions[sessionKey];
      if (!current || (!current.statsStale && !current.statsRefreshPending)) return state;
      return {
        sessions: touchSession(
          state.sessions,
          sessionKey,
          { ...current, statsStale: false, statsRefreshPending: false, lastUpdatedAt: now },
          state.currentSessionKey,
        ),
      };
    });
  },
  flushStatsRefresh: (sessionKey: string, now = Date.now()) => {
    let shouldRefresh = false;
    set((state) => {
      const current = state.sessions[sessionKey];
      if (
        !current?.statsRefreshPending ||
        (current.lastStatsRefreshAt !== undefined &&
          now - current.lastStatsRefreshAt < NEK_STATUS_STATS_THROTTLE_MS)
      ) {
        return state;
      }
      shouldRefresh = true;
      return {
        sessions: touchSession(
          state.sessions,
          sessionKey,
          {
            ...current,
            statsRefreshPending: false,
            lastStatsRefreshAt: now,
            lastUpdatedAt: now,
          },
          state.currentSessionKey,
        ),
      };
    });
    return shouldRefresh;
  },
  tick: (sessionKey: string, now = Date.now()) => {
    set((state) => {
      const current = state.sessions[sessionKey];
      if (!current) return state;
      const advanced = advanceNekStatus(current, now);
      if (advanced === current) return state;
      return {
        sessions: touchSession(state.sessions, sessionKey, advanced, state.currentSessionKey),
      };
    });
  },
  markStopRequested: (sessionKey: string, id: string, now = Date.now()) => {
    set((state) => {
      const current = state.sessions[sessionKey];
      if (!current) return state;
      const next = markStopRequested(current, id, now);
      if (next === current) return state;
      return {
        sessions: touchSession(state.sessions, sessionKey, next, state.currentSessionKey),
      };
    });
  },
  clearStopRequested: (sessionKey: string, id: string) => {
    set((state) => {
      const current = state.sessions[sessionKey];
      if (!current) return state;
      const next = clearStopRequested(current, id);
      if (next === current) return state;
      return {
        sessions: touchSession(state.sessions, sessionKey, next, state.currentSessionKey),
      };
    });
  },
  clearRetry: (sessionKey: string) => {
    set((state) => {
      const current = state.sessions[sessionKey];
      if (!current || current.retry === null) return state;
      return {
        sessions: touchSession(
          state.sessions,
          sessionKey,
          { ...current, retry: null },
          state.currentSessionKey,
        ),
      };
    });
  },
  setCurrentSession: (sessionKey: string | null, now = Date.now()) => {
    set((state) => {
      if (sessionKey === null) return { currentSessionKey: null };
      const current = getOrCreate(state.sessions, sessionKey, now);
      return {
        currentSessionKey: sessionKey,
        sessions: touchSession(state.sessions, sessionKey, current, sessionKey),
      };
    });
  },
  reset: () => set({ sessions: EMPTY_SESSIONS, currentSessionKey: null }),
}));

export function selectNekSessionStatus(
  state: NekStatusStoreStateWithSession,
  sessionKey: string,
): NekSessionStatus | undefined {
  return state.sessions[sessionKey];
}
