/**
 * 账号登录流程：startLogin → 事件流（auth_url / device_code / 提示输入）→ done / failed / cancelled。
 * 事件归约是纯函数，便于测试；hook 负责订阅、应答与取消。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { NekAuthPromptPayload, NekLoginEvent } from "@zcode/shared/nek-protocol";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { toNekConfigApiError } from "./nekErrors.js";

export interface LoginActive {
  phase: "active";
  loginId: string;
  provider: string;
  forwardedPorts: number[];
  authUrl?: { url: string; instructions?: string };
  deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
  infos: Array<{ message: string; links?: Array<{ url: string; label?: string }> }>;
  progress?: string;
  prompt?: { promptId: string; payload: NekAuthPromptPayload };
  answering: boolean;
}

export type LoginState =
  | { phase: "idle" }
  | { phase: "starting"; provider: string }
  | LoginActive
  | { phase: "done"; provider: string }
  | { phase: "failed"; provider: string; message: string }
  | { phase: "cancelled"; provider: string };

export type LoginAction =
  | { type: "start"; provider: string }
  | { type: "started"; loginId: string; forwardedPorts: number[] }
  | { type: "startFailed"; message: string }
  | { type: "event"; loginId: string; event: NekLoginEvent }
  | { type: "answering" }
  | { type: "answerFailed"; message: string }
  | { type: "reset" };

const MAX_INFOS = 20;

function reduceAuthEvent(
  state: LoginActive,
  event: Extract<NekLoginEvent, { type: "auth_event" }>,
): LoginActive {
  const inner = event.record.event;
  switch (inner.type) {
    case "auth_url":
      return { ...state, authUrl: { url: inner.url, instructions: inner.instructions } };
    case "device_code":
      return {
        ...state,
        deviceCode: {
          userCode: inner.userCode,
          verificationUri: inner.verificationUri,
          expiresInSeconds: inner.expiresInSeconds,
        },
      };
    case "info":
      return {
        ...state,
        infos: [...state.infos, { message: inner.message, links: inner.links }].slice(-MAX_INFOS),
      };
    case "progress":
      return { ...state, progress: inner.message };
  }
}

function reduceActiveEvent(state: LoginActive, event: NekLoginEvent): LoginState {
  switch (event.type) {
    case "auth_event":
      return reduceAuthEvent(state, event);
    case "prompt":
      return {
        ...state,
        prompt: { promptId: event.promptId, payload: event.payload },
        answering: false,
      };
    case "prompt_cancelled":
      return state.prompt?.promptId === event.promptId
        ? { ...state, prompt: undefined, answering: false }
        : state;
    case "done":
      return { phase: "done", provider: state.provider };
    case "failed":
      return { phase: "failed", provider: state.provider, message: event.message };
    case "cancelled":
      return { phase: "cancelled", provider: state.provider };
  }
}

export function reduceLogin(state: LoginState, action: LoginAction): LoginState {
  switch (action.type) {
    case "start":
      return { phase: "starting", provider: action.provider };
    case "started":
      if (state.phase !== "starting") {
        return state;
      }
      return {
        phase: "active",
        provider: state.provider,
        loginId: action.loginId,
        forwardedPorts: action.forwardedPorts,
        infos: [],
        answering: false,
      };
    case "startFailed":
      return state.phase === "starting"
        ? { phase: "failed", provider: state.provider, message: action.message }
        : state;
    case "event":
      return state.phase === "active" && state.loginId === action.loginId
        ? reduceActiveEvent(state, action.event)
        : state;
    case "answering":
      return state.phase === "active" ? { ...state, answering: true } : state;
    case "answerFailed":
      return state.phase === "active"
        ? { ...state, answering: false, progress: action.message }
        : state;
    case "reset":
      return { phase: "idle" };
  }
}

export function useNekLogin() {
  const { config, target, notifyWrite } = useNekSettingsContext();
  const [state, dispatch] = useReducer(reduceLogin, { phase: "idle" });
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const detach = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  useEffect(() => {
    if (state.phase === "done") {
      detach();
      notifyWrite();
    } else if (state.phase === "failed" || state.phase === "cancelled") {
      detach();
    }
  }, [state.phase, detach, notifyWrite]);

  const start = useCallback(
    async (provider: string) => {
      detach();
      dispatch({ type: "start", provider });
      try {
        const session = await config.startLogin(target, provider);
        // 先进入 active，再订阅：实现若在订阅时回放缓存的事件，也能被归约。
        dispatch({
          type: "started",
          loginId: session.loginId,
          forwardedPorts: session.forwardedPorts,
        });
        unsubscribeRef.current = config.onLoginEvent(session.loginId, (event) =>
          dispatch({ type: "event", loginId: session.loginId, event }),
        );
      } catch (error) {
        dispatch({ type: "startFailed", message: toNekConfigApiError(error).message });
      }
    },
    [config, target, detach],
  );

  const answer = useCallback(
    async (value: string) => {
      const current = stateRef.current;
      if (current.phase !== "active" || !current.prompt) {
        return;
      }
      dispatch({ type: "answering" });
      try {
        await config.answerLoginPrompt(current.loginId, current.prompt.promptId, value);
      } catch (error) {
        dispatch({ type: "answerFailed", message: toNekConfigApiError(error).message });
      }
    },
    [config],
  );

  const cancel = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase === "active") {
      await config.cancelLogin(current.loginId);
    }
    detach();
    dispatch({ type: "reset" });
  }, [config, detach]);

  const reset = useCallback(() => {
    detach();
    dispatch({ type: "reset" });
  }, [detach]);

  return { state, start, answer, cancel, reset };
}
