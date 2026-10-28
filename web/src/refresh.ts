import { useEffect, useRef } from 'react';

/**
 * M6 shared refresh.
 *
 * Every screen that shows shared coordination state (My work, case detail, institutions, coordination,
 * reports, alerts) subscribes to one 10-second cycle, so a change made by another officer becomes
 * visible inside the product's 10-second target without a manual reload. Three rules keep it honest:
 *
 *  - one timer per mounted screen and it is cleared on unmount, so navigating away (or signing out)
 *    removes the listener and the cached rows with it;
 *  - the cycle pauses while the tab is hidden and runs immediately when it becomes visible again;
 *  - a successful write from this tab triggers an immediate refresh of every subscribed screen, so the
 *    officer never waits for the next tick to see their own change.
 *
 * The refresh always re-issues the same authenticated request: it never reuses another user's data, so
 * a restricted record cannot appear through the refresh path (the server decides visibility per
 * request, exactly as it does for the first load).
 */
/**
 * The cycle is *shorter* than the 10-second product target on purpose: the target covers the whole
 * journey from another officer's write to the rendered row, which includes the request and the render
 * after the tick. A 10-second timer would spend the entire budget before the request even started
 * (M7/A15). Four seconds leaves room for a slow request and still lands well inside the target.
 */
export const REFRESH_INTERVAL_MS = 4_000;
const REFRESH_EVENT = 'caselink:refresh';

/**
 * Whether this tab currently holds a session. `api.setAuthToken` keeps it in step, so a background tick
 * that lands after sign-out (or after the API rejected the token) does nothing instead of firing an
 * unauthenticated request. That is what keeps the console clean on sign-out: no 401s from the timer.
 */
let sessionActive = false;
export function setRefreshSession(active: boolean): void {
  sessionActive = active;
}

/** Fire after a mutating request succeeds, so subscribed screens reload straight away. */
export function notifyLocalWrite(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function useSharedRefresh(reload: () => void | Promise<void>, options: { intervalMs?: number; enabled?: boolean } = {}): void {
  const latest = useRef(reload);
  latest.current = reload;
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: number | undefined;
    let stopped = false;
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const run = () => {
      if (!stopped && sessionActive && visible()) void latest.current();
    };
    const start = () => {
      if (timer === undefined) timer = window.setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (visible()) {
        run();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(REFRESH_EVENT, run);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(REFRESH_EVENT, run);
    };
  }, [enabled, intervalMs]);
}
