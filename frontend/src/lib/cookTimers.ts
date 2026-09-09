// ════════════════════════════════════════════════════════════════════════
// SmartChef — Kitchen timers
//
// Every step already carries a durationMin, and cook mode has always shown
// it as static text. This makes it startable.
//
// Two design points worth stating:
//
//   - State lives at module level, not in a component. A timer has to keep
//     running when you leave cook mode to check the shopping list or answer
//     the door, and unmounting the screen must not silently cancel the
//     roast. Subscribers re-render; the timers themselves are independent
//     of any of them.
//
//   - Deadlines are absolute timestamps, never a decremented counter. A
//     setInterval that subtracts a second per tick drifts, and is throttled
//     hard when the page is hidden — which is most of a 45-minute timer.
//     Storing `endsAt` means a backgrounded tab that wakes up late still
//     computes exactly the right remaining time, and a timer that expired
//     while hidden fires the moment the page comes back.
// ════════════════════════════════════════════════════════════════════════

export interface CookTimer {
  id: string;
  /** What is cooking — shown on the chip and in the notification. */
  label: string;
  /** Absolute epoch ms. Recomputing from this is what makes the timer
   *  immune to throttling and drift. */
  endsAt: number;
  totalMs: number;
  /** Set once it has fired, so the UI can show it needs dismissing. */
  rungAt?: number;
}

type Listener = (timers: CookTimer[]) => void;

let timers: CookTimer[] = [];
const listeners = new Set<Listener>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit() {
  const snapshot = [...timers];
  listeners.forEach((l) => l(snapshot));
}

function ensureTicker() {
  if (ticker || timers.length === 0) return;
  ticker = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const timer of timers) {
      if (!timer.rungAt && now >= timer.endsAt) {
        timer.rungAt = now;
        changed = true;
        void ring(timer);
      }
    }
    // Re-emit every tick regardless: the countdown text has to move even
    // when nothing has fired.
    emit();
    if (changed && timers.every((t) => t.rungAt)) stopTickerIfIdle();
  }, 500);
}

function stopTickerIfIdle() {
  if (ticker && timers.length === 0) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function subscribeCookTimers(listener: Listener): () => void {
  listeners.add(listener);
  listener([...timers]);
  return () => {
    listeners.delete(listener);
  };
}

export function listCookTimers(): CookTimer[] {
  return [...timers];
}

export function startCookTimer(input: { id: string; label: string; minutes: number }): void {
  const totalMs = Math.max(1, Math.round(input.minutes * 60_000));
  // Restarting an existing id replaces it rather than stacking a second
  // countdown on the same step.
  timers = timers.filter((t) => t.id !== input.id);
  timers.push({ id: input.id, label: input.label, endsAt: Date.now() + totalMs, totalMs });
  ensureTicker();
  emit();
}

export function cancelCookTimer(id: string): void {
  timers = timers.filter((t) => t.id !== id);
  stopTickerIfIdle();
  emit();
}

export function clearAllCookTimers(): void {
  timers = [];
  stopTickerIfIdle();
  emit();
}

export function remainingMs(timer: CookTimer, now = Date.now()): number {
  return Math.max(0, timer.endsAt - now);
}

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Ringing ─────────────────────────────────────────────────────────────
//
// Sound first: hands are wet and the phone is across the counter, so the
// audible cue is the one that matters. Synthesised with Web Audio rather
// than shipping an asset — no file to load, no autoplay policy to fight
// (this is a response to a user gesture chain), and it works identically
// in the Electron build and the Android WebView.
//
// A system notification is added on top when permission has been granted.
// Native Capacitor notifications (which would fire with the app fully
// backgrounded) would need @capacitor/local-notifications; that is a
// worthwhile upgrade, not a prerequisite.

async function ring(timer: CookTimer): Promise<void> {
  playChime();
  notify(timer.label);
}

function playChime(): void {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // Three rising notes — distinct from a phone notification, and short
    // enough not to be irritating when several finish together.
    [0, 0.18, 0.36].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = [660, 880, 1180][i];
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // No audio output, or a context the browser refused. The on-screen
    // chip still turns red — never worth throwing over.
  }
}

function notify(label: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification('Timer finished', { body: label, tag: `smartchef-timer-${label}` });
  } catch {
    /* notifications unavailable — the chime and the chip are enough */
  }
}

/** Asked for the first time a timer is started, not on page load: a
 *  permission prompt out of nowhere is the fastest way to get it denied
 *  permanently. */
export function requestTimerNotifications(): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    /* ignore */
  }
}
