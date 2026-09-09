import { useEffect, useRef, useState } from 'react';

// ════════════════════════════════════════════════════════════════════════
// SmartChef — Keep the screen on while cooking
//
// Kitchen mode is read across a whole cook, mostly without touching the
// device, so the screen dims and locks exactly when both hands are busy.
// navigator.wakeLock fixes that. It is Chromium 84+, so it works in the
// Electron desktop build (114) and in the Android WebView.
//
// The one thing that always catches people: the browser drops the lock
// whenever the page is hidden — tab switch, app backgrounded, screen locked
// manually — and does NOT restore it on return. Without the visibilitychange
// re-acquire below, the lock silently stops working the first time you look
// at something else, which reads as "it only works sometimes".
// ════════════════════════════════════════════════════════════════════════

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void> };

export type WakeLockState = 'unsupported' | 'idle' | 'active' | 'denied';

/** Holds a screen wake lock while `enabled`. Safe to call where the API
 *  doesn't exist — it reports 'unsupported' and does nothing else. */
export function useWakeLock(enabled: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>('idle');
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const wakeLock = (navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    }).wakeLock;

    if (!wakeLock) {
      setState('unsupported');
      return;
    }
    if (!enabled) {
      setState('idle');
      return;
    }

    let cancelled = false;

    const acquire = async () => {
      // Requesting while hidden always rejects; the visibilitychange
      // handler below picks it up when the page comes back.
      if (document.visibilityState !== 'visible') return;
      if (sentinelRef.current && !sentinelRef.current.released) return;
      try {
        const sentinel = await wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
        setState('active');
      } catch {
        // Battery saver, an OS policy, or a user-agent that exposes the API
        // but refuses it. Not worth an error — cooking still works, the
        // screen just dims as it did before.
        setState('denied');
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
      setState('idle');
    };
  }, [enabled]);

  return state;
}
