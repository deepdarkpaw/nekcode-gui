import { useEffect, useRef, useState } from "react";

export interface DialogDeadlineOptions {
  timeout?: number;
  now?: () => number;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onExpired: () => void;
}

export interface DialogDeadlineView {
  remainingMs?: number;
}

/** A one-second injected ticker for extension dialog deadlines. */
export function useDialogDeadline({
  timeout,
  now = () => Date.now(),
  setIntervalFn = (callback, delayMs) => setInterval(callback, delayMs),
  clearIntervalFn = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  onExpired,
}: DialogDeadlineOptions): DialogDeadlineView {
  const [deadline] = useState(() =>
    timeout === undefined ? undefined : now() + Math.max(0, timeout),
  );
  const [remainingMs, setRemainingMs] = useState<number | undefined>(() =>
    deadline === undefined ? undefined : Math.max(0, deadline - now()),
  );
  const expiredRef = useRef(false);
  useEffect(() => {
    if (deadline === undefined) return;
    const tick = () => {
      const remaining = Math.max(0, deadline - now());
      setRemainingMs(remaining);
      if (remaining === 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpired();
      }
    };
    tick();
    const handle = setIntervalFn(tick, 1000);
    return () => clearIntervalFn(handle);
  }, [clearIntervalFn, deadline, now, onExpired, setIntervalFn]);
  return deadline === undefined ? {} : { remainingMs };
}
