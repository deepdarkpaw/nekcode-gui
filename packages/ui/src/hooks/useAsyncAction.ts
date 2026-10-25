/**
 * 异步动作 hook：防重复提交、成功 ✓ 自动复位、失败保留原因。
 * AsyncButton 与即时保存设置字段共用。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  ASYNC_ACTION_IDLE,
  ASYNC_SUCCESS_FEEDBACK_MS,
  describeAsyncError,
  reduceAsyncAction,
  type AsyncActionState,
} from "@/lib/asyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface UseAsyncActionOptions {
  /** 成功 ✓ 的展示时长；0 表示不展示（交给调用方 toast）。 */
  successFeedbackMs?: number;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export interface AsyncActionHandle<A extends unknown[]> {
  state: AsyncActionState;
  /** 执行动作；正在执行时直接返回 false（不重复提交）。成功返回 true。 */
  run: (...args: A) => Promise<boolean>;
  /** 清除成功/失败状态。 */
  reset: () => void;
}

export function useAsyncAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown> | unknown,
  options: UseAsyncActionOptions = {},
): AsyncActionHandle<A> {
  const { intl } = useZCodeIntl();
  const [state, dispatch] = useReducer(reduceAsyncAction, ASYNC_ACTION_IDLE);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ action, options });
  latestRef.current = { action, options };

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearResetTimer();
    };
  }, [clearResetTimer]);

  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      if (inFlightRef.current) {
        return false;
      }
      inFlightRef.current = true;
      clearResetTimer();
      dispatch({ type: "start" });
      const { action: current, options: currentOptions } = latestRef.current;
      try {
        await current(...args);
      } catch (error) {
        inFlightRef.current = false;
        if (mountedRef.current) {
          const message = describeAsyncError(
            error,
            intl.formatMessage({ id: "ui.asyncAction.failed" }),
          );
          dispatch({ type: "reject", message });
        }
        currentOptions.onError?.(error);
        return false;
      }
      inFlightRef.current = false;
      if (mountedRef.current) {
        dispatch({ type: "resolve" });
        const feedbackMs = currentOptions.successFeedbackMs ?? ASYNC_SUCCESS_FEEDBACK_MS;
        resetTimerRef.current = setTimeout(() => dispatch({ type: "reset" }), feedbackMs);
      }
      currentOptions.onSuccess?.();
      return true;
    },
    [clearResetTimer, intl],
  );

  const reset = useCallback(() => {
    clearResetTimer();
    dispatch({ type: "reset" });
  }, [clearResetTimer]);

  return { state, run, reset };
}
