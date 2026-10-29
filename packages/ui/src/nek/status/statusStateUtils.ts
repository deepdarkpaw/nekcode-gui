import { NEK_STATUS_STATS_THROTTLE_MS, type NekSessionStatus } from "./types.js";

export function updateTimestamp(state: NekSessionStatus, now: number): NekSessionStatus {
  return state.lastUpdatedAt === now ? state : { ...state, lastUpdatedAt: now };
}

export function makeNotice(
  sessionKey: string,
  id: string,
  createdAt: number,
): { id: string; sessionKey: string; createdAt: number } {
  return { id, sessionKey, createdAt };
}

export function markStatsStale(
  state: NekSessionStatus,
  now: number,
): { state: NekSessionStatus; needsStatsRefresh: boolean } {
  const canRequest =
    state.lastStatsRefreshAt === undefined ||
    now - state.lastStatsRefreshAt >= NEK_STATUS_STATS_THROTTLE_MS;
  return {
    state: {
      ...state,
      statsStale: true,
      statsRefreshPending: !canRequest,
      ...(canRequest ? { lastStatsRefreshAt: now } : {}),
      lastUpdatedAt: now,
    },
    needsStatsRefresh: canRequest,
  };
}
