import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NekMentionTargetInfo } from "@zcode/shared/nek-protocol";
import { isImeComposing } from "@/lib/imeComposition.js";
import {
  buildNekMentionCandidates,
  buildNekMentionReplacement,
  createMentionTargetsCache,
  mentionQueryForCursor,
  type MentionReplacement,
  type NekMentionCandidate,
  type NekMentionFile,
} from "./nekMentionLogic.js";

export interface NekMentionState {
  open: boolean;
  query: string | undefined;
  selected: number;
  dismissedQuery?: string;
  loading: boolean;
  error?: string;
  candidates: NekMentionCandidate[];
}

export type NekMentionEvent =
  | { type: "query"; query: string | undefined }
  | { type: "loaded"; query: string; candidates: NekMentionCandidate[] }
  | { type: "loadError"; query: string; error: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "dismiss" }
  | { type: "highlight"; index: number }
  | { type: "close" };

function wrapIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  return (current + delta + count) % count;
}

export function createNekMentionState(): NekMentionState {
  return { open: false, query: undefined, selected: -1, loading: false, candidates: [] };
}

export function reduceNekMention(state: NekMentionState, event: NekMentionEvent): NekMentionState {
  switch (event.type) {
    case "query": {
      const open = event.query !== undefined && event.query !== state.dismissedQuery;
      return {
        ...state,
        open,
        query: event.query,
        selected: 0,
        loading: open,
        error: undefined,
        candidates: open ? [] : state.candidates,
      };
    }
    case "loaded":
      return event.query === state.query
        ? {
            ...state,
            open: state.dismissedQuery !== event.query,
            loading: false,
            error: undefined,
            candidates: event.candidates,
            selected: event.candidates.length ? 0 : -1,
          }
        : state;
    case "loadError":
      return event.query === state.query
        ? { ...state, loading: false, error: event.error, candidates: [], selected: -1 }
        : state;
    case "move":
      return state.candidates.length === 0
        ? state
        : {
            ...state,
            selected: wrapIndex(
              state.selected < 0 ? 0 : state.selected,
              event.delta,
              state.candidates.length,
            ),
          };
    case "dismiss":
      return { ...state, open: false, dismissedQuery: state.query };
    case "highlight":
      return event.index >= 0 && event.index < state.candidates.length
        ? { ...state, selected: event.index }
        : state;
    case "close":
      return { ...state, open: false };
  }
}

export function resolveNekMentionKey(input: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  candidateCount: number;
  selected: number;
}): "next" | "previous" | "accept" | "dismiss" | null {
  if (isImeComposing(input)) return null;
  if (input.key === "ArrowDown") return "next";
  if (input.key === "ArrowUp") return "previous";
  if (
    (input.key === "Enter" || input.key === "Tab") &&
    input.selected >= 0 &&
    input.candidateCount > 0
  )
    return "accept";
  if (input.key === "Escape") return "dismiss";
  return null;
}

export interface NekMentionControllerProps {
  textBeforeCaret: string;
  sessionKey: string;
  fetchTargets: (
    sessionKey: string,
    signal?: AbortSignal,
  ) => Promise<readonly NekMentionTargetInfo[]>;
  fetchFiles: (query: string, signal?: AbortSignal) => Promise<readonly NekMentionFile[]>;
  onReplace: (replacement: MentionReplacement, candidate: NekMentionCandidate) => void;
  cache?: ReturnType<typeof createMentionTargetsCache>;
}

export interface NekMentionController {
  view: NekMentionState;
  accept: (index?: number) => boolean;
  highlight: (index: number) => void;
  retry: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

export function useNekMentionController({
  textBeforeCaret,
  sessionKey,
  fetchTargets,
  fetchFiles,
  onReplace,
  cache,
}: NekMentionControllerProps): NekMentionController {
  const query = mentionQueryForCursor(textBeforeCaret);
  const [state, dispatch] = useReducer(reduceNekMention, undefined, createNekMentionState);
  const generationRef = useRef(0);
  const targetCache = useMemo(
    () => cache ?? createMentionTargetsCache((key, signal) => fetchTargets(key, signal)),
    [cache, fetchTargets],
  );
  const load = useCallback(() => {
    if (query === undefined) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    dispatch({ type: "query", query });
    void Promise.all([
      targetCache.load(sessionKey, controller.signal),
      fetchFiles(query, controller.signal),
    ])
      .then(([targets, files]) => {
        if (generation !== generationRef.current) return;
        dispatch({
          type: "loaded",
          query,
          candidates: buildNekMentionCandidates(query, targets, files),
        });
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        dispatch({
          type: "loadError",
          query,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [fetchFiles, query, sessionKey, targetCache]);
  useEffect(() => load(), [load]);

  const accept = useCallback(
    (index = state.selected) => {
      const candidate = state.candidates[index];
      if (!candidate) return false;
      const replacement = buildNekMentionReplacement(textBeforeCaret, candidate);
      if (!replacement) return false;
      onReplace(replacement, candidate);
      dispatch({ type: "close" });
      return true;
    },
    [onReplace, state.candidates, state.selected, textBeforeCaret],
  );
  const retry = useCallback(() => load(), [load]);
  const highlight = useCallback((index: number) => dispatch({ type: "highlight", index }), []);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const command = resolveNekMentionKey({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        candidateCount: state.candidates.length,
        selected: state.selected,
      });
      if (!command) return;
      if (command === "next") dispatch({ type: "move", delta: 1 });
      else if (command === "previous") dispatch({ type: "move", delta: -1 });
      else if (command === "dismiss") {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: "dismiss" });
      } else if (command === "accept") {
        event.preventDefault();
        event.stopPropagation();
        accept();
      }
    },
    [accept, state.candidates.length, state.selected],
  );

  return { view: state, accept, highlight, retry, onKeyDown };
}
