// ════════════════════════════════════════════════════════════════════════
// A page for LOOKING at the pieces this release changed.
//
// The app itself cannot be opened without a backend or a first-run setup,
// and the test suite has no jsdom, so neither one can answer "does the
// amber still look like amber after tokenising it" or "does the arc menu
// overlap itself at seven actions". This renders the real components and
// the real formatter against fixtures.
//
// Served at /probe.html by the dev server. Not part of the app build's
// entry points and not linked from anywhere in it.
// ════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { formatDurationWith } from './lib/duration';
import { applyAccentScheme, applyThemeMode } from './lib/applySettings';
import FloatingActionBar, { FLOATING_ACTION_BAR_CLEARANCE } from './components/FloatingActionBar';

/** Stands in for i18next: renders the real key set from en.json so the
 *  duration output is the actual shipped wording. */
const STRINGS: Record<string, [string, string]> = {
  'duration.week': ['{{count}} week', '{{count}} weeks'],
  'duration.day': ['{{count}} day', '{{count}} days'],
  'duration.hour': ['{{count}} hour', '{{count}} hours'],
  'duration.minute': ['{{count}} minute', '{{count}} minutes'],
  'duration.weekShort': ['{{count}}w', '{{count}}w'],
  'duration.dayShort': ['{{count}}d', '{{count}}d'],
  'duration.hourShort': ['{{count}}h', '{{count}}h'],
  'duration.minuteShort': ['{{count}}m', '{{count}}m'],
};
const t = (key: string, options?: Record<string, unknown>) => {
  const count = Number(options?.count ?? 0);
  const forms = STRINGS[key];
  if (!forms) return key;
  return (count === 1 ? forms[0] : forms[1]).replace('{{count}}', String(count));
};

const SCHEMES = ['garden', 'ember', 'indigo', 'plum'];
const BAR_BUTTON = 'w-11 h-11 justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800';
const ACTIONS = ['download', 'shopping_cart', 'bookmark', 'ios_share', 'call_merge', 'delete', 'edit'];

/** The real durations that motivated lib/duration.ts, plus the edges. */
const DURATIONS = [0, 15, 45, 60, 90, 150, 1440, 1800, 10080, 21600, 64800];

function Probe() {
  const [scheme, setScheme] = useState('garden');
  const [dark, setDark] = useState(false);

  const pick = (next: string) => {
    setScheme(next);
    applyAccentScheme(next);
  };
  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    applyThemeMode(next ? 'dark' : 'light');
  };

  return (
    <div className="min-h-screen bg-background text-on-background p-6 space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        {SCHEMES.map((s) => (
          <button
            key={s}
            onClick={() => pick(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 ${scheme === s ? 'border-primary bg-primary/10 text-primary' : 'border-zinc-200 dark:border-zinc-700'}`}
          >
            {s}
          </button>
        ))}
        <button onClick={toggleDark} className="px-3 py-1.5 rounded-full text-xs font-bold bg-primary text-white">
          {dark ? 'light' : 'dark'}
        </button>
        <span data-probe="ready" className="text-xs opacity-50">scheme={scheme} dark={String(dark)}</span>
      </div>

      <section>
        <h2 className="text-sm font-black uppercase tracking-wider opacity-60 mb-3">Entity colours</h2>
        {/* The point of tokenising: these three must stay distinguishable
            from each other in every scheme and in both modes. */}
        <p className="text-base leading-relaxed max-w-prose">
          Whisk the <span className="text-ingredient font-bold underline decoration-ingredient/70">eggs</span> with the{' '}
          <span className="text-tool font-bold underline decoration-tool/70">stand mixer</span>, then{' '}
          <span className="text-technique font-bold underline decoration-technique/70">fold</span> in the{' '}
          <span className="text-ingredient font-bold underline decoration-ingredient/70">flour</span>.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-ingredient/10 text-ingredient">ingredient</span>
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-tool/10 text-tool">tool</span>
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-technique/10 text-technique">technique</span>
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-tool text-white">tool solid</span>
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-technique text-white">technique solid</span>
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-white">primary</span>
          {/* Warning amber deliberately does NOT follow the scheme. */}
          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-500">warning (unchanged)</span>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-black uppercase tracking-wider opacity-60 mb-3">Durations</h2>
        <table className="text-sm tabular-nums" data-probe="durations">
          <tbody>
            {DURATIONS.map((m) => (
              <tr key={m} className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="pr-6 py-1 opacity-50">{m} min</td>
                <td className="pr-6 py-1 font-bold">{formatDurationWith(t, m, { short: true })}</td>
                <td className="py-1">{formatDurationWith(t, m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-sm font-black uppercase tracking-wider opacity-60 mb-3">Radial actions</h2>
        <p className="text-sm opacity-60 max-w-prose">
          Seven actions, the most a recipe ever shows. Tap the button bottom-right.
          Nothing here may use a transform on a wrapper — the share and collection
          popovers inside these buttons are <code>position: fixed</code>.
        </p>
      </section>

      <div style={{ height: FLOATING_ACTION_BAR_CLEARANCE }} aria-hidden="true" />
      <FloatingActionBar label="Recipe actions">
        {ACTIONS.map((icon) => (
          <button key={icon} className={`${BAR_BUTTON} flex items-center text-zinc-500 dark:text-zinc-400`} aria-label={icon}>
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </button>
        ))}
      </FloatingActionBar>
    </div>
  );
}

createRoot(document.getElementById('probe')!).render(<Probe />);
