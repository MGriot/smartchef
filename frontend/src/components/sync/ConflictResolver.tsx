// ════════════════════════════════════════════════════════════════════════
// SmartChef — the Conflicts card (wayfinder ticket 06, redesigned for ADR 0006)
//
// What is left here after the merge rules have settled everything they can
// (equal values, one side empty, tag lists, the newer edit) is a field both
// devices genuinely changed differently. Each is shown as the two versions
// side by side — this device's and the other's, with when each was edited
// and which is newer — rendered the way the recipe itself shows them:
// tags as chips, times in minutes, a photo as a photo, steps one by one
// with what changed highlighted. Tapping a version keeps it.
//
// Colours are GitHub's diff palette: this device is a deletion row ("−",
// red), the other device an addition row ("+", green), each with a darker
// gutter, dark text, and a stronger tint only on the words that differ.
// ════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SyncConflict } from '../../services/conflicts.local';
import { isEmptyValue, parseTimestamp, setMembers, SET_FIELDS } from '../../lib/mergeNormalize';
import { diffLines, type DiffOp } from '../../lib/lineDiff';
import CoverImage from '../CoverImage';

export type Side = 'local' | 'remote';

/** What each side is called. The sync card's defaults are this device and
 *  the other one; the recipe merge view passes the kept recipe and the
 *  duplicate instead. */
export interface SideLabels {
  local: string;
  remote: string;
  localOnly: string;
  remoteOnly: string;
  useLocal: string;
  useRemote: string;
}

function useSideLabels(labels?: SideLabels): SideLabels {
  const { t } = useTranslation();
  return labels ?? {
    local: t('account.conflicts.thisDevice'),
    remote: t('account.conflicts.otherDevice'),
    localOnly: t('account.conflicts.mineOnly'),
    remoteOnly: t('account.conflicts.theirsOnly'),
    useLocal: t('account.conflicts.useThisDevice'),
    useRemote: t('account.conflicts.useOtherDevice'),
  };
}

export interface DisplayConflict extends SyncConflict {
  entityName: string;
}

const IMAGE_FIELDS = new Set(['cover_image_url', 'avatar_url']);
const MINUTE_FIELDS = new Set(['prep_time_min', 'cook_time_min', 'rest_time_min']);
const LONG_TEXT_FIELDS = new Set(['description', 'tips', 'storage_instructions', 'title', 'name']);
const LIST_FIELDS = new Set(['steps', 'ingredients', 'toolIds', 'exclude_tag_ids', 'sources', 'tag_ids']);
const TRANSLATION_FIELDS = new Set(['translations', 'group_translations']);

/** Sections of an entity's card, in the order the recipe itself reads. */
export type SectionKey = 'info' | 'ingredients' | 'steps' | 'translations' | 'other';
export const SECTION_ORDER: SectionKey[] = ['info', 'ingredients', 'steps', 'translations', 'other'];
const INFO_FIELDS = new Set([
  'title', 'name', 'description', 'difficulty', 'servings', 'prep_time_min', 'cook_time_min', 'rest_time_min',
  'rating', 'yield_amount', 'yield_unit_id', 'cover_image_url', 'tags', 'regions', 'creator_name',
  'storage_instructions', 'tips', 'category_name', 'icon', 'color', 'image_urls', 'symbol', 'plural_name',
]);

export function sectionOf(fieldName: string): SectionKey {
  if (fieldName === 'steps') return 'steps';
  if (fieldName === 'ingredients' || fieldName === 'toolIds') return 'ingredients';
  if (TRANSLATION_FIELDS.has(fieldName)) return 'translations';
  if (INFO_FIELDS.has(fieldName)) return 'info';
  return 'other';
}
const DIFFICULTY_KEYS: Record<string, string> = {
  easy: 'gallery.difficultyEasy', medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced', expert: 'gallery.difficultyExpert',
};

function fieldLabel(t: TFunction, fieldName: string): string {
  return t(`account.conflicts.fields.${fieldName}`, { defaultValue: fieldName.replace(/_/g, ' ') });
}

function entityTypeLabel(t: TFunction, entityType: string): string {
  return t(`account.conflicts.entityTypes.${entityType}`, { defaultValue: entityType });
}

function relativeTime(t: TFunction, ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return t('account.time.justNow');
  if (mins < 60) return t('account.time.minutesAgo', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('account.time.hoursAgo', { count: hours });
  return t('account.time.daysAgo', { count: Math.round(hours / 24) });
}

function newerOf(conflict: SyncConflict): Side | null {
  const l = parseTimestamp(conflict.localUpdatedAt);
  const r = parseTimestamp(conflict.remoteUpdatedAt);
  if (l === null || r === null || l === r) return null;
  return l > r ? 'local' : 'remote';
}

// ── Word-level highlighting for text ────────────────────────────────────

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part !== '');
}

/** The words of `text` marked as shared with the other version or not. */
function markedWords(mine: string, other: string, side: Side): Array<{ text: string; changed: boolean }> {
  const ops = side === 'local' ? diffLines(tokenize(mine), tokenize(other)) : diffLines(tokenize(other), tokenize(mine));
  const own = side === 'local' ? 'removed' : 'added';
  const tokens = ops.filter((op) => op.type === 'same' || op.type === own).map((op) => ({ text: op.text, changed: op.type === own }));
  // Whitespace between two changed words belongs to the change, so a
  // rewritten sentence reads as one highlight rather than a row of boxes.
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!tokens[i].changed && /^\s+$/.test(tokens[i].text) && tokens[i - 1].changed && tokens[i + 1].changed) tokens[i].changed = true;
  }
  const runs: Array<{ text: string; changed: boolean }> = [];
  for (const token of tokens) {
    const last = runs[runs.length - 1];
    if (last && last.changed === token.changed) last.text += token.text;
    else runs.push({ ...token });
  }
  return runs;
}

// ── Git diff palette ────────────────────────────────────────────────────
const DIFF = {
  local: {
    row: 'bg-[#ffebe9] dark:bg-[#f8514926]',
    gutter: 'bg-[#ffd7d5] text-[#cf222e] dark:bg-[#f851494d] dark:text-[#ff7b72]',
    word: 'bg-[#ff818266] dark:bg-[#f8514966]',
    sign: '−',
  },
  remote: {
    row: 'bg-[#e6ffec] dark:bg-[#2ea04326]',
    gutter: 'bg-[#ccffd8] text-[#1a7f37] dark:bg-[#3fb9504d] dark:text-[#56d364]',
    word: 'bg-[#abf2bc] dark:bg-[#2ea04366]',
    sign: '+',
  },
} as const;
const DIFF_TEXT = 'font-mono text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200';

/** One line of a git diff: tinted row, darker gutter holding − or +. */
function DiffRow({ side, children }: { side: Side; children: ReactNode }) {
  return (
    <div className={`flex ${DIFF[side].row}`}>
      <span className={`w-7 shrink-0 select-none text-center font-mono text-sm font-bold pt-2 ${DIFF[side].gutter}`}>{DIFF[side].sign}</span>
      <div className="min-w-0 flex-1 px-3 py-2">{children}</div>
    </div>
  );
}

/** The "■ solo i miei ■ solo i loro" strip at the top of a diff block,
 *  with a "più recente" badge beside whichever side was edited last. */
function DiffLegend({ newer, labels }: { newer?: Side | null; labels?: SideLabels }) {
  const { t } = useTranslation();
  const l = useSideLabels(labels);
  const badge = (
    <span className="px-1.5 py-px rounded bg-primary/10 text-primary tracking-wider normal-case font-black">{t('account.conflicts.newer')}</span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700 text-[10px] font-black uppercase tracking-widest">
      <span className="flex items-center gap-1.5 text-[#cf222e] dark:text-[#ff7b72]"><span className="w-2.5 h-2.5 rounded-sm bg-[#cf222e] dark:bg-[#ff7b72]" />{l.localOnly}{newer === 'local' && badge}</span>
      <span className="flex items-center gap-1.5 text-[#1a7f37] dark:text-[#56d364]"><span className="w-2.5 h-2.5 rounded-sm bg-[#1a7f37] dark:bg-[#56d364]" />{l.remoteOnly}{newer === 'remote' && badge}</span>
    </div>
  );
}

function HighlightedText({ text, other, side }: { text: string; other: string; side: Side }) {
  const words = markedWords(text, other, side);
  return (
    <p className={`${DIFF_TEXT} whitespace-pre-wrap break-words`}>
      {words.map((w, i) => (w.changed ? <mark key={i} className={`${DIFF[side].word} text-inherit rounded-sm`}>{w.text}</mark> : <span key={i}>{w.text}</span>))}
    </p>
  );
}

// ── One version of a scalar field ───────────────────────────────────────

function ValueView({ conflict, side }: { conflict: DisplayConflict; side: Side }) {
  const { t } = useTranslation();
  const value = side === 'local' ? conflict.localValue : conflict.remoteValue;
  const other = side === 'local' ? conflict.remoteValue : conflict.localValue;
  const field = conflict.fieldName;

  if (isEmptyValue(value)) return <p className="text-sm italic text-zinc-400 dark:text-zinc-500">{t('account.conflicts.empty')}</p>;

  if (TRANSLATION_FIELDS.has(field)) return <TranslationsView value={value} other={other} side={side} />;

  if (IMAGE_FIELDS.has(field) && typeof value === 'string') {
    return (
      <div className="w-full aspect-video rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        <CoverImage src={value} alt={fieldLabel(t, field)} className="w-full h-full object-cover" iconSize={28} />
      </div>
    );
  }

  if (SET_FIELDS.has(field)) {
    const otherKeys = new Set(setMembers(other).map((m) => String(m)));
    return (
      <div className="flex flex-wrap gap-1.5">
        {setMembers(value).map((member) => {
          const unique = !otherKeys.has(String(member));
          return (
            <span
              key={String(member)}
              className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                unique
                  ? `${DIFF[side].word} text-zinc-900 dark:text-zinc-100`
                  : 'bg-white/70 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {String(member)}
            </span>
          );
        })}
      </div>
    );
  }

  if (MINUTE_FIELDS.has(field)) return <p className="text-lg font-black text-zinc-800 dark:text-zinc-100">{String(value)} min</p>;
  if (field === 'difficulty' && typeof value === 'string') {
    return <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{DIFFICULTY_KEYS[value] ? t(DIFFICULTY_KEYS[value]) : value}</p>;
  }
  if (typeof value === 'string' && (LONG_TEXT_FIELDS.has(field) || value.length > 40) && typeof other === 'string') {
    return <HighlightedText text={value} other={other} side={side} />;
  }
  if (typeof value === 'object') {
    return <pre className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all font-mono">{JSON.stringify(value, null, 2)}</pre>;
  }
  return <p className="text-sm text-zinc-700 dark:text-zinc-300 break-words">{String(value)}</p>;
}

function translationEntries(value: unknown): Array<Record<string, unknown>> {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>).filter((e) => e && typeof e.lang === 'string') : [];
}

function translationText(entry: Record<string, unknown>): string {
  return Object.entries(entry).filter(([k, v]) => k !== 'lang' && typeof v === 'string' && v).map(([, v]) => v).join(' — ');
}

/** One line per language; languages that differ from the other version
 *  carry this side's colour. */
function TranslationsView({ value, other, side }: { value: unknown; other: unknown; side: Side }) {
  const others = new Map(translationEntries(other).map((e) => [String(e.lang).toLowerCase(), translationText(e)]));
  const tone = DIFF[side].word;
  return (
    <ul className="space-y-1">
      {translationEntries(value).map((entry) => {
        const text = translationText(entry);
        const differs = others.get(String(entry.lang).toLowerCase()) !== text;
        return (
          <li key={String(entry.lang)} className={`flex gap-2 rounded-lg px-2 py-1 text-sm ${differs ? tone : ''}`}>
            <span className="shrink-0 w-7 text-[11px] font-black uppercase text-zinc-400 pt-0.5">{String(entry.lang)}</span>
            <span className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A version the user can keep by tapping it — one row of the diff. */
function VersionCard({ conflict, side, newer, onPick, children, labels, selected }: {
  conflict: DisplayConflict; side: Side; newer: Side | null; onPick: () => void; children: ReactNode;
  labels?: SideLabels; selected?: boolean;
}) {
  const { t } = useTranslation();
  const l = useSideLabels(labels);
  const ms = parseTimestamp(side === 'local' ? conflict.localUpdatedAt : conflict.remoteUpdatedAt);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={`group block w-full min-w-0 text-left hover:brightness-[0.97] dark:hover:brightness-110 transition ${selected ? 'ring-2 ring-inset ring-primary' : ''}`}
    >
      <DiffRow side={side}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
          <span className="text-[11px] font-black text-zinc-700 dark:text-zinc-200">
            {side === 'local' ? l.local : l.remote}
          </span>
          {ms !== null && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{relativeTime(t, ms)}</span>}
          {newer === side && (
            <span className="px-1.5 py-px rounded bg-white/80 dark:bg-zinc-900/60 text-primary text-[10px] font-black uppercase tracking-wider">{t('account.conflicts.newer')}</span>
          )}
          <span className={`ml-auto inline-flex items-center gap-1 text-[11px] font-black group-hover:text-primary ${selected ? 'text-primary' : 'text-zinc-500'}`}>
            <span className="material-symbols-outlined text-[16px]">{selected ? 'check_circle' : 'radio_button_unchecked'}</span>
            {t('account.conflicts.keepThisVersion')}
          </span>
        </div>
        <div className="min-w-0">{children}</div>
      </DiffRow>
    </button>
  );
}

// ── Steps / ingredients / other lists, aligned item by item ─────────────

type AlignedRow =
  | { kind: 'same'; count: number; lines: string[] }
  | { kind: 'changed'; mine: string | null; theirs: string | null };

/** Pairs up the two lists: runs of identical items collapse, and a removed
 *  item directly followed by an added one is shown as one changed item. */
function alignLists(ops: DiffOp[]): AlignedRow[] {
  const rows: AlignedRow[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'same') {
      const last = rows[rows.length - 1];
      if (last && last.kind === 'same') {
        last.count++;
        last.lines.push(op.text);
      } else rows.push({ kind: 'same', count: 1, lines: [op.text] });
    } else if (op.type === 'removed' && ops[i + 1]?.type === 'added') {
      rows.push({ kind: 'changed', mine: op.text, theirs: ops[i + 1].text });
      i++;
    } else {
      rows.push({ kind: 'changed', mine: op.type === 'removed' ? op.text : null, theirs: op.type === 'added' ? op.text : null });
    }
  }
  return rows;
}

function ListCompare({ conflict, newer, onPick, labels, selected }: {
  conflict: DisplayConflict; newer: Side | null; onPick: (side: Side) => void; labels?: SideLabels; selected?: Side | null;
}) {
  const { t } = useTranslation();
  const l = useSideLabels(labels);
  const [rows, setRows] = useState<AlignedRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { formatArrayFieldLines } = await import('../../services/conflicts.local');
        const [mine, theirs] = await Promise.all([
          formatArrayFieldLines(conflict.entityType, conflict.fieldName, conflict.localValue),
          formatArrayFieldLines(conflict.entityType, conflict.fieldName, conflict.remoteValue),
        ]);
        if (!cancelled) setRows(alignLists(diffLines(mine, theirs)));
      } catch (err) {
        console.error('ConflictResolver: could not format list field', err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [conflict]);

  const identicalKey = conflict.fieldName === 'steps' ? 'account.conflicts.identicalSteps' : 'account.conflicts.identicalItems';

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 overflow-hidden">
        <DiffLegend newer={newer} labels={labels} />
        {failed && <p className="p-4 text-sm text-zinc-500">{t('account.conflicts.cannotCompare')}</p>}
        {!failed && !rows && <p className="p-4 text-sm text-zinc-400">{t('common.loading')}</p>}
        <div className="divide-y divide-white/60 dark:divide-zinc-900">
          {rows?.map((row, i) =>
            row.kind === 'same' ? (
              <div key={i}>
                {/* Collapsed unchanged lines, like the hunk expander on GitHub. */}
                <button
                  type="button"
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                  className="flex w-full items-center gap-2 bg-[#ddf4ff] dark:bg-[#388bfd1a] text-[#0969da] dark:text-[#58a6ff] text-xs font-bold hover:brightness-95"
                >
                  <span className="w-7 shrink-0 self-stretch flex items-center justify-center bg-[#b6e3ff] dark:bg-[#388bfd33]">
                    <span className="material-symbols-outlined text-[16px]">{expanded.has(i) ? 'expand_less' : 'expand_more'}</span>
                  </span>
                  <span className="py-1.5">{t(identicalKey, { count: row.count })}</span>
                </button>
                {expanded.has(i) && row.lines.map((line, j) => (
                  <div key={j} className="flex">
                    <span className="w-7 shrink-0" />
                    <p className={`${DIFF_TEXT} text-zinc-500 dark:text-zinc-400 px-3 py-1.5 break-words`}>{line}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div key={i}>
                {row.mine !== null && <DiffRow side="local"><HighlightedText text={row.mine} other={row.theirs ?? ''} side="local" /></DiffRow>}
                {row.theirs !== null && <DiffRow side="remote"><HighlightedText text={row.theirs} other={row.mine ?? ''} side="remote" /></DiffRow>}
              </div>
            )
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(['local', 'remote'] as Side[]).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => onPick(side)}
            aria-pressed={selected === side}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black transition-colors ${selected === side ? 'ring-2 ring-primary ring-offset-2 ring-offset-white dark:ring-offset-zinc-950' : ''} ${
              side === 'local'
                ? 'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'
                : 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900'
            }`}
          >
            <span className={`font-mono ${side === 'local' ? 'text-[#cf222e] dark:text-[#ff7b72]' : 'text-[#56d364] dark:text-[#1a7f37]'}`}>{DIFF[side].sign}</span>
            {side === 'local' ? l.useLocal : l.useRemote}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FieldConflict({ conflict, onResolve, labels, selected, children }: {
  conflict: DisplayConflict;
  onResolve: (side: Side) => void;
  labels?: SideLabels;
  /** The side currently chosen, for a view that keeps the field on screen
   *  after a pick instead of resolving it away. */
  selected?: Side | null;
  /** Extra choices under the versions (the merge view's "keep both"). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const newer = newerOf(conflict);
  const isList = LIST_FIELDS.has(conflict.fieldName);
  return (
    <div className="space-y-2">
      <p className="text-xs font-black uppercase tracking-widest text-zinc-500 dark:text-zinc-400">{fieldLabel(t, conflict.fieldName)}</p>
      {isList ? (
        <ListCompare conflict={conflict} newer={newer} onPick={onResolve} labels={labels} selected={selected} />
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <DiffLegend newer={newer} labels={labels} />
          {(['local', 'remote'] as Side[]).map((side) => (
            <VersionCard key={side} conflict={conflict} side={side} newer={newer} onPick={() => onResolve(side)} labels={labels} selected={selected === side}>
              <ValueView conflict={conflict} side={side} />
            </VersionCard>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

export function EntityConflicts({ conflicts, busy, onResolve, onResolveAll }: {
  conflicts: DisplayConflict[];
  busy: boolean;
  onResolve: (id: string, side: Side) => void;
  onResolveAll: (choice: Side | 'newest') => void;
}) {
  const { t } = useTranslation();
  const first = conflicts[0];
  const anyNewer = conflicts.some((c) => newerOf(c) !== null);
  const bySection = new Map<SectionKey, DisplayConflict[]>();
  for (const c of conflicts) {
    const key = sectionOf(c.fieldName);
    bySection.set(key, [...(bySection.get(key) ?? []), c]);
  }
  return (
    <section className="rounded-3xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-100 dark:border-zinc-800">
      <header className="p-4 sm:p-5 pb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-base font-black text-zinc-900 dark:text-zinc-100 min-w-0 break-words">{first.entityName}</h3>
        <span className="px-2.5 py-0.5 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
          {entityTypeLabel(t, first.entityType)} · {t('account.conflicts.differenceCount', { count: conflicts.length })}
        </span>
      </header>

      <div className="px-4 sm:px-5 space-y-3">
        {SECTION_ORDER.filter((key) => bySection.has(key)).map((key) => {
          const items = bySection.get(key)!;
          return (
            <details key={key} open className="group/section rounded-2xl bg-white dark:bg-zinc-950 border border-zinc-100 dark:border-zinc-800">
              <summary className="flex items-center justify-between gap-2 cursor-pointer list-none px-4 py-3 select-none">
                <span className="text-sm font-black text-zinc-800 dark:text-zinc-100">
                  {t(`account.conflicts.sections.${key}`)}
                  <span className="ml-2 text-[11px] font-bold text-zinc-400">{items.length}</span>
                </span>
                <span className="material-symbols-outlined text-zinc-400 transition-transform group-open/section:rotate-180">expand_more</span>
              </summary>
              <div className="px-4 pb-4 space-y-5">
                {items.map((c) => (
                  <FieldConflict key={c.id} conflict={c} onResolve={(side) => onResolve(c.id, side)} />
                ))}
              </div>
            </details>
          );
        })}
      </div>

      {/* Sticky so the whole-item choices stay in reach while scrolling
          through a long recipe on a phone. */}
      <div
        className="sticky z-10 mt-3 p-3 rounded-b-3xl bg-zinc-50/95 dark:bg-zinc-900/95 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap gap-2"
        style={{ bottom: 'env(safe-area-inset-bottom)' }}
      >
        {anyNewer && (
          <button type="button" disabled={busy} onClick={() => onResolveAll('newest')} className="flex-1 min-w-[8rem] px-3 py-2 rounded-full bg-primary text-white text-xs font-black disabled:opacity-50">
            {t('account.conflicts.keepNewest')}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onResolveAll('local')} className="flex-1 min-w-[8rem] px-3 py-2 rounded-full bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 text-xs font-black disabled:opacity-50">
          <span className="font-mono text-[#cf222e] dark:text-[#ff7b72]">−</span> {t('account.conflicts.keepAllMine')}
        </button>
        <button type="button" disabled={busy} onClick={() => onResolveAll('remote')} className="flex-1 min-w-[8rem] px-3 py-2 rounded-full bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 text-xs font-black disabled:opacity-50">
          <span className="font-mono text-[#56d364] dark:text-[#1a7f37]">+</span> {t('account.conflicts.keepAllTheirs')}
        </button>
      </div>
    </section>
  );
}

/** Renders nothing while there is nothing to decide. */
export default function ConflictsCard() {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState<DisplayConflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Items pending when the card first loaded — the denominator of "3 of 12".
  const [initialTotal, setInitialTotal] = useState<number | null>(null);

  const refresh = async () => {
    try {
      const { listPendingConflicts, getEntityDisplayName } = await import('../../services/conflicts.local');
      const pending = await listPendingConflicts();
      const names = new Map<string, string>();
      for (const c of pending) {
        const key = `${c.entityType}:${c.entityId}`;
        if (!names.has(key)) names.set(key, (await getEntityDisplayName(c.entityType, c.entityId)) ?? `${c.entityType} ${c.entityId.slice(0, 8)}…`);
      }
      setConflicts(pending.map((c) => ({ ...c, entityName: names.get(`${c.entityType}:${c.entityId}`)! })));
      setInitialTotal((total) => Math.max(total ?? 0, names.size));
    } catch (err) {
      // Stays invisible rather than an error card for a feature meant to
      // show nothing until there's something to decide.
      console.error('ConflictsCard: could not load pending conflicts', err);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const run = async (work: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.conflicts.couldNotResolve'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const handleResolve = (id: string, side: Side) => run(async () => {
    const { resolveConflict, applyResolvedConflict } = await import('../../services/conflicts.local');
    const resolved = await resolveConflict(id, side);
    if (resolved) await applyResolvedConflict(resolved);
  });

  const handleResolveEntity = (entityType: string, entityId: string, choice: Side | 'newest') => run(async () => {
    const { resolveEntityConflicts } = await import('../../services/conflicts.local');
    await resolveEntityConflicts(entityType, entityId, choice);
  });

  const handleAutoResolve = () => run(async () => {
    const [{ autoResolvePendingConflicts }, { readRemoteEntityUpdatedAt }] = await Promise.all([
      import('../../services/conflicts.local'),
      import('../../lib/sync/gitSync'),
    ]);
    const outcome = await autoResolvePendingConflicts('newest', readRemoteEntityUpdatedAt);
    setNotice(outcome.resolved > 0
      ? t('account.conflicts.autoResolvedCount', { count: outcome.resolved })
      : t('account.conflicts.nothingAutoResolvable'));
  });

  if (!conflicts || conflicts.length === 0) {
    return notice ? <p className="text-sm font-medium text-primary px-2">{notice}</p> : null;
  }

  const groups = new Map<string, DisplayConflict[]>();
  for (const c of conflicts) {
    const key = `${c.entityType}:${c.entityId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-3xl sm:rounded-[40px] p-4 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100 mb-1">{t('account.conflicts.heading')}</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">{t('account.conflicts.subtitle', { count: groups.size })}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleAutoResolve}
          className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-black disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[18px]">auto_fix_high</span>
          {t('account.conflicts.autoResolveAll')}
        </button>
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-3">{t('account.conflicts.howToChoose')}</p>
      {initialTotal !== null && initialTotal > 1 && (
        <div className="mb-5">
          <div className="flex justify-between text-[11px] font-bold text-zinc-400 mb-1">
            <span>{t('account.conflicts.progress', { done: initialTotal - groups.size, total: initialTotal })}</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${((initialTotal - groups.size) / initialTotal) * 100}%` }} />
          </div>
        </div>
      )}
      {notice && <p className="text-sm text-primary font-medium mb-3">{notice}</p>}
      {error && <p className="text-sm text-red-600 font-medium mb-3 break-words">{error}</p>}
      <div className="space-y-4">
        {[...groups.entries()].map(([key, entityConflicts]) => (
          <EntityConflicts
            key={key}
            conflicts={entityConflicts}
            busy={busy}
            onResolve={handleResolve}
            onResolveAll={(choice) => handleResolveEntity(entityConflicts[0].entityType, entityConflicts[0].entityId, choice)}
          />
        ))}
      </div>
    </div>
  );
}
