import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import ImageUrlInput from '../components/ImageUrlInput';
import { useStore } from '../store/app.store';
import { useTranslation } from 'react-i18next';
// Module-level helpers below take `t` as a parameter rather than reaching
// for a singleton: they are plain functions, not components, so there is no
// hook to call — and passing it keeps them re-rendering with the language.
import type { TFunction } from 'i18next';
import { stalePush } from '../lib/sync/syncStatus';
import { useLanguages } from '../hooks/useLanguages';
import { isValidLanguageCode, languageLabel, normalizeLanguageCode } from '../lib/languages';
import { persistUiLang } from '../lib/uiLanguage';
import type { ThemeMode } from '../store/app.store';
import { apiFetch, isNative, getServerUrl } from '../lib/api';
import { AVATAR_PRESETS, DEFAULT_AVATAR } from '../lib/avatarPresets';
import { ResolvedImage } from '../components/CoverImage';
import type { StandaloneProfile } from '../lib/standalone';
import type { MigrationSummary } from '../lib/storageMigration';
import type { SyncResult } from '../lib/sync/gitSync';
import type { TransferProgress } from '../lib/sync/gitObjectTransport';
import type { SyncInterval, SyncIntervalUnit, GitRemoteAccessProblem } from '../lib/sync/syncSettings';
import type { RemoteAccessKind, RemoteAccessResult } from '../lib/sync/remoteAccessProbe';
import { RemoteAccessNotice } from '../components/RemoteAccessNotice';
import { checkTokenShape } from '../lib/sync/tokenShape';
import { ExportSetupFileDialog, ImportSetupFileDialog } from '../components/SetupFileDialog';
import type { AppliedSetup } from '../lib/setupFileTransfer';

// How each verdict reads. Only 'writable' is a success; the amber group is
// "this works for reading and will never upload", which is precisely the
// state that used to render as a green "credentials accepted".
const TEST_RESULT_TONE: Record<RemoteAccessKind, string> = {
  writable: 'text-emerald-700',
  'read-only': 'text-amber-700 dark:text-amber-300',
  'token-rejected': 'text-amber-700 dark:text-amber-300',
  'no-credentials': 'text-amber-700 dark:text-amber-300',
  'malformed-token': 'text-amber-700 dark:text-amber-300',
  'not-found': 'text-red-600',
  unreachable: 'text-red-600',
};

const TEST_RESULT_ICON: Record<RemoteAccessKind, string> = {
  writable: 'check_circle',
  'read-only': 'warning',
  'token-rejected': 'warning',
  'no-credentials': 'warning',
  'malformed-token': 'warning',
  'not-found': 'error',
  unreachable: 'error',
};

interface SyncPeer {
  deviceId: string;
  deviceName: string;
  lastSeenAt: string;
}

interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'electron';
  lastSyncAt: string;
}

interface SyncStatus {
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  lastSyncAt?: string | null;
  peers?: SyncPeer[];
}

interface SyncSummary {
  categories: number; tools: number; techniques: number; tags: number;
  ingredients: number; recipes: number;
  conflicts: string[];
}

// The entity types a sync cycle counts. Only the KEYS are listed here — the
// words come from `account.entity.*`, which is plural-aware, so "1 recipe"
// reads correctly in every language rather than being pluralised by an `s`
// this file appends itself.
const SYNC_SUMMARY_TYPES = ['categories', 'tools', 'techniques', 'tags', 'ingredients', 'recipes'] as const;

function SyncSummaryPanel({ summary }: { summary: SyncSummary }) {
  const { t } = useTranslation();
  const changes = SYNC_SUMMARY_TYPES
    .map((key) => ({ key, count: summary[key] }))
    .filter((c) => c.count > 0);

  return (
    <div className="mt-4 p-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl space-y-2">
      {changes.length === 0 && (summary.conflicts ?? []).length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium">{t('account.sync.nothingChanged')}</p>
      ) : (
        <>
          {changes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {changes.map((c) => (
                <span key={c.key} className="px-2.5 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[11px] font-bold text-zinc-600 dark:text-zinc-400">
                  {t(`account.entity.${c.key}`, { count: c.count })}
                </span>
              ))}
            </div>
          )}
          {(summary.conflicts ?? []).length > 0 && (
            <div className="space-y-1 pt-1">
              {summary.conflicts.map((msg, i) => (
                <p key={i} className="text-[11px] text-amber-700 leading-snug flex items-start gap-1.5">
                  <span className="material-symbols-outlined text-[13px] shrink-0 mt-px">warning</span>
                  {msg}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The singular entity names Structured Merge reports against, mapped to
 *  the plural-aware `account.entity.*` keys. An unknown type falls back to
 *  its own raw name rather than being guessed at with an English "s". */
const ENTITY_TYPE_KEY: Record<string, string> = {
  recipe: 'recipes', ingredient: 'ingredients', tool: 'tools', tag: 'tags', technique: 'techniques', profile: 'profiles',
};

/** "3 recipes, 5 ingredients" — the "which type" half of what a sync cycle
 *  pulled in, since a bare count doesn't say whether it was recipes,
 *  ingredients, or something else. Empty string (not "0 changes") when
 *  there's nothing to break down, so callers fall back to a plain count. */
function formatAppliedByType(t: TFunction, byType: Partial<Record<string, number>>): string {
  return Object.entries(byType)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([type, count]) => {
      const key = ENTITY_TYPE_KEY[type];
      return key ? t(`account.entity.${key}`, { count }) : `${count} ${type}`;
    })
    .join(', ');
}

// Diagnostic-only, not user-facing polish: "remote files this device's
// tree walk actually found" per entity type, independent of whether any
// of them ended up applied — see MergeBridgeResult.entityScanCounts for
// why. A type that's supposed to have entries but reads 0 here means the
// gap is upstream of Structured Merge entirely (the fetch, or which
// commit got resolved as "remote"), not the merge/write logic downstream.
function formatScanCounts(counts: Record<string, { remoteFiles: number; localFiles: number }>): string {
  return Object.entries(counts)
    .map(([type, c]) => `${type} ${c.remoteFiles}↓/${c.localFiles}↑`)
    .join(', ');
}

function formatRelativeTime(t: TFunction, iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t('account.time.justNow');
  if (mins < 60) return t('account.time.minutesAgo', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('account.time.hoursAgo', { count: hours });
  return t('account.time.daysAgo', { count: Math.round(hours / 24) });
}

interface DisplayConflict {
  id: string;
  entityType: string;
  entityId: string;
  fieldName: string;
  localValue: unknown;
  remoteValue: unknown;
  entityName: string;
}

function conflictValuePreview(t: TFunction, value: unknown): string {
  if (Array.isArray(value)) return t('account.conflicts.itemCount', { count: value.length });
  return String(value);
}

type LineDiffOp = { type: 'same' | 'removed' | 'added'; text: string };

/** GitHub-style unified diff: a colored +/- gutter plus a full-row red/
 *  green background, instead of a plain badge — the ask being "make the
 *  differences easier to actually see," not just technically present. */
function LineDiffView({ ops }: { ops: LineDiffOp[] }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden font-mono text-xs">
      <div className="px-3 py-1.5 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3 text-[10px] font-sans font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
        <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />{t('account.conflicts.mineOnly')}</span>
        <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />{t('account.conflicts.theirsOnly')}</span>
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {ops.map((op, i) => (
          <div key={i} className={`flex ${op.type === 'removed' ? 'bg-red-50 dark:bg-red-950/30' : op.type === 'added' ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}>
            <span
              className={`w-7 shrink-0 text-center select-none font-black ${
                op.type === 'removed' ? 'bg-red-100 text-red-500 dark:bg-red-900/40 dark:text-red-400' : op.type === 'added' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400' : 'text-zinc-300 dark:text-zinc-700'
              }`}
            >
              {op.type === 'removed' ? '−' : op.type === 'added' ? '+' : ''}
            </span>
            <span className={`px-3 py-1 flex-1 whitespace-pre-wrap ${op.type === 'removed' ? 'text-red-800 dark:text-red-300' : op.type === 'added' ? 'text-emerald-800 dark:text-emerald-300' : 'text-zinc-600 dark:text-zinc-400'}`}>
              {op.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConflictFieldDiff({ conflict, onResolve }: { conflict: DisplayConflict; onResolve: (chosen: 'local' | 'remote') => void }) {
  const { t } = useTranslation();
  const [ops, setOps] = useState<LineDiffOp[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const isArrayField = Array.isArray(conflict.localValue) || Array.isArray(conflict.remoteValue);
  // Every array-valued field — plain string/number lists (tags, regions,
  // seasonal_months...), id-reference lists (toolIds, exclude_tag_ids...),
  // and recipe's steps/ingredients row objects — goes through
  // conflicts.local.ts's formatArrayFieldLines(), which resolves whatever
  // it can into a readable line per item (ADR 0002 still applies: this is
  // display only, not per-row merging). It only throws for an array of
  // objects it hasn't been taught to format (e.g. recipe.sources) — that
  // falls back to the plain count-only view below instead of crashing.
  useEffect(() => {
    let cancelled = false;
    setOps(null);
    setUnsupported(false);
    if (!isArrayField) return;

    (async () => {
      try {
        const [{ formatArrayFieldLines }, { diffLines }] = await Promise.all([
          import('../services/conflicts.local'),
          import('../lib/lineDiff'),
        ]);
        const [localLines, remoteLines] = await Promise.all([
          formatArrayFieldLines(conflict.entityType, conflict.fieldName, conflict.localValue),
          formatArrayFieldLines(conflict.entityType, conflict.fieldName, conflict.remoteValue),
        ]);
        if (!cancelled) setOps(diffLines(localLines, remoteLines));
      } catch (err) {
        console.error('ConflictFieldDiff: could not format array field for diff', err);
        if (!cancelled) setUnsupported(true);
      }
    })();

    return () => { cancelled = true; };
  }, [conflict, isArrayField]);

  if (isArrayField && unsupported) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 bg-white dark:bg-zinc-900 rounded-xl p-3 border border-zinc-200 dark:border-zinc-700">
          <div className="text-xs text-zinc-600 dark:text-zinc-400 font-medium">
            <span className="font-black text-zinc-800 dark:text-zinc-200">{t('account.conflicts.mineLabel')}</span> {conflictValuePreview(t, conflict.localValue)}
            <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
            <span className="font-black text-zinc-800 dark:text-zinc-200">{t('account.conflicts.theirsLabel')}</span> {conflictValuePreview(t, conflict.remoteValue)}
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={() => onResolve('local')} className="px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-[11px] font-black text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700">{t('account.conflicts.mine')}</button>
            <button type="button" onClick={() => onResolve('remote')} className="px-2.5 py-1 bg-zinc-900 text-white rounded-lg text-[11px] font-black hover:bg-zinc-800">{t('account.conflicts.theirs')}</button>
          </div>
        </div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {t('account.conflicts.noPerRowIdentity')}
        </p>
      </div>
    );
  }

  if (isArrayField) {
    return (
      <div className="space-y-2">
        <LineDiffView ops={ops ?? []} />
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => onResolve('local')} className="px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-[11px] font-black text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700">{t('account.conflicts.keepMine')}</button>
          <button type="button" onClick={() => onResolve('remote')} className="px-2.5 py-1 bg-zinc-900 text-white rounded-lg text-[11px] font-black hover:bg-zinc-800">{t('account.conflicts.keepTheirs')}</button>
        </div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {t('account.conflicts.wholeListReplaced')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-white dark:bg-zinc-900 rounded-xl p-3 border border-zinc-200 dark:border-zinc-700">
      <div className="text-xs text-zinc-600 dark:text-zinc-400 font-medium">
        <span className="font-black text-zinc-800 dark:text-zinc-200">{t('account.conflicts.mineLabel')}</span> {conflictValuePreview(t, conflict.localValue)}
        <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
        <span className="font-black text-zinc-800 dark:text-zinc-200">{t('account.conflicts.theirsLabel')}</span> {conflictValuePreview(t, conflict.remoteValue)}
      </div>
      <div className="flex gap-2 shrink-0">
        <button type="button" onClick={() => onResolve('local')} className="px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-[11px] font-black text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700">{t('account.conflicts.mine')}</button>
        <button type="button" onClick={() => onResolve('remote')} className="px-2.5 py-1 bg-zinc-900 text-white rounded-lg text-[11px] font-black hover:bg-zinc-800">{t('account.conflicts.theirs')}</button>
      </div>
    </div>
  );
}

function ConflictEntityGroup({
  entityConflicts, openField, onOpenField, onResolve,
}: {
  entityConflicts: DisplayConflict[];
  openField: string;
  onOpenField: (fieldName: string) => void;
  onResolve: (id: string, chosen: 'local' | 'remote') => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-black text-zinc-800 dark:text-zinc-200">{entityConflicts[0].entityName}</p>
        <span className="px-2.5 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-full text-[10px] font-black text-zinc-500 dark:text-zinc-400 capitalize">
          {entityConflicts[0].entityType} · {t('account.conflicts.conflictCount', { count: entityConflicts.length })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {entityConflicts.map((c) => (
          <button
            key={c.fieldName}
            type="button"
            onClick={() => onOpenField(c.fieldName)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${openField === c.fieldName ? 'bg-zinc-900 text-white' : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'}`}
          >
            {c.fieldName}
          </button>
        ))}
      </div>
      {entityConflicts.filter((c) => c.fieldName === openField).map((c) => (
        <ConflictFieldDiff key={c.id} conflict={c} onResolve={(chosen) => onResolve(c.id, chosen)} />
      ))}
    </div>
  );
}

/** wayfinder ticket 06 (standalone-storage-sync map) — entity-grouped
 *  Conflicts list (the prototyped Variant C), folded into production and
 *  wired to conflicts.local.ts's real data. mergeBridge.ts creates a
 *  sync_conflicts row whenever a real sync cycle finds a field genuinely
 *  diverged on both sides (see applyEntityMergeResult()); this card
 *  renders nothing only when there's nothing actually pending. */
function ConflictsCard() {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState<DisplayConflict[] | null>(null);
  const [openField, setOpenField] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const { listPendingConflicts, getEntityDisplayName } = await import('../services/conflicts.local');
      const pending = await listPendingConflicts();
      const withNames = await Promise.all(
        pending.map(async (c) => ({
          ...c,
          entityName: (await getEntityDisplayName(c.entityType, c.entityId)) ?? `${c.entityType} ${c.entityId.slice(0, 8)}…`,
        }))
      );
      setConflicts(withNames);
    } catch (err) {
      // Stays invisible (conflicts left null, same as the loading state)
      // rather than showing an error card for a feature that's supposed to
      // render nothing until there's something real to show — but at least
      // doesn't crash the rest of the Account page over an unhandled
      // rejection the way an unguarded refresh() would.
      console.error('ConflictsCard: could not load pending conflicts', err);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResolve = async (id: string, chosen: 'local' | 'remote') => {
    setError(null);
    try {
      const { resolveConflict, applyResolvedConflict } = await import('../services/conflicts.local');
      const resolved = await resolveConflict(id, chosen);
      if (resolved) await applyResolvedConflict(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.conflicts.couldNotResolve'));
    }
    await refresh();
  };

  if (!conflicts || conflicts.length === 0) return null;

  const groups = new Map<string, DisplayConflict[]>();
  for (const c of conflicts) {
    const key = `${c.entityType}:${c.entityId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100 mb-1">{t('account.conflicts.heading')}</h2>
      <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mb-4">
        {t('account.conflicts.subtitle', { count: groups.size })}
      </p>
      {error && <p className="text-sm text-red-600 font-medium mb-3">{error}</p>}
      <div className="space-y-3">
        {[...groups.entries()].map(([key, entityConflicts]) => (
          <ConflictEntityGroup
            key={key}
            entityConflicts={entityConflicts}
            openField={openField[key] ?? entityConflicts[0].fieldName}
            onOpenField={(fieldName) => setOpenField((s) => ({ ...s, [key]: fieldName }))}
            onResolve={handleResolve}
          />
        ))}
      </div>
    </div>
  );
}

const SYNC_INTERVAL_PRESETS: SyncInterval[] = [
  { value: 5, unit: 'minutes' },
  { value: 30, unit: 'minutes' },
  { value: 1, unit: 'hours' },
  { value: 1, unit: 'days' },
  { value: 1, unit: 'weeks' },
];

const SYNC_INTERVAL_UNIT_ABBREV: Record<SyncIntervalUnit, string> = {
  minutes: 'm', hours: 'h', days: 'd', weeks: 'w', months: 'mo',
};

function formatSyncInterval(interval: SyncInterval): string {
  return `${interval.value}${SYNC_INTERVAL_UNIT_ABBREV[interval.unit]}`;
}

function FolderSyncCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [standalone, setStandalone] = useState(false);
  const [electron, setElectron] = useState(false);
  // Sync settings affect the whole shared library across every device, not
  // just this profile — only an admin profile may change them (mirrors the
  // same admin-only gating server mode already applies to Manage Users).
  const [isAdmin, setIsAdmin] = useState(false);
  const [syncMode, setSyncModeState] = useState<'folder' | 'git-remote'>('folder');
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [gitRemoteUrl, setGitRemoteUrl] = useState('');
  const [gitRemoteUsername, setGitRemoteUsername] = useState('');
  const [gitRemoteToken, setGitRemoteToken] = useState('');
  const [gitRemoteTokenConfigured, setGitRemoteTokenConfigured] = useState(false);
  const [gitRemoteTokenTouched, setGitRemoteTokenTouched] = useState(false);
  const [gitRemoteCorsProxy, setGitRemoteCorsProxy] = useState('');
  // Recomputed on every keystroke, but only once the field has been
  // touched — a stored token this build cannot judge must not light up a
  // warning the user did not cause.
  const tokenShapeProblem = gitRemoteTokenTouched ? checkTokenShape(gitRemoteUrl, gitRemoteToken) : null;
  const [showCorsProxy, setShowCorsProxy] = useState(false);
  const [savingGitRemote, setSavingGitRemote] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<RemoteAccessResult | null>(null);
  // Loaded from Preferences rather than component state: the screen that
  // DETECTS a rejected token is first-run setup, which has no way to fix
  // it. This is where it gets fixed, so this is where it has to be shown.
  const [accessProblem, setAccessProblem] = useState<GitRemoteAccessProblem | null>(null);
  const [intervalValue, setIntervalValueState] = useState(5);
  const [intervalUnit, setIntervalUnitState] = useState<SyncIntervalUnit>('minutes');
  const [savingInterval, setSavingInterval] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceName, setDeviceNameState] = useState('');
  const [savedDeviceName, setSavedDeviceName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  // Distinct from lastSyncAt, which advances whenever a cycle COMPLETES —
  // including one that fetched perfectly and pushed nothing, which is
  // exactly the state that hid a week of failed pushes.
  const [lastPushAt, setLastPushAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [resyncingAll, setResyncingAll] = useState(false);
  const [resyncProgress, setResyncProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Setup File (lib/setupConfigFile.ts) — everything above, in one encrypted
  // file, so a second device doesn't mean retyping a repo URL and a token.
  const [exportingSetup, setExportingSetup] = useState(false);
  const [importingSetup, setImportingSetup] = useState(false);
  const [setupImported, setSetupImported] = useState<AppliedSetup | null>(null);

  const refreshDevices = async () => {
    const { listDeviceRecords } = await import('../lib/sync/gitSync');
    setDevices(await listDeviceRecords());
  };

  /** Re-reads exactly what a Setup File import can change, so the card shows
   *  the imported values instead of the ones it loaded at mount. */
  const reloadSyncSettings = async () => {
    const { getSyncMode, getGitRemoteConfig, getSyncInterval } = await import('../lib/sync/syncSettings');
    const [mode, interval, gitRemoteConfig] = await Promise.all([
      getSyncMode(),
      getSyncInterval(),
      getGitRemoteConfig(),
    ]);
    setSyncModeState(mode);
    setIntervalValueState(interval.value);
    setIntervalUnitState(interval.unit);
    setGitRemoteUrl(gitRemoteConfig?.url ?? '');
    setGitRemoteUsername(gitRemoteConfig?.username ?? '');
    setGitRemoteCorsProxy(gitRemoteConfig?.corsProxy ?? '');
    setShowCorsProxy(!!gitRemoteConfig?.corsProxy);
    setGitRemoteTokenConfigured(!!gitRemoteConfig?.token);
    // An imported token is a brand-new credential, so any problem recorded
    // against the previous one is stale: keep it off the screen until this
    // device has actually tried the new one.
    setGitRemoteToken('');
    setGitRemoteTokenTouched(false);
    setConnectionTestResult(null);
    await refreshSyncHealth();
  };

  // No platform guard: this used to early-return on Electron, on the
  // reasoning that desktop has no separate mirror step to pause. The state
  // is plain Preferences and the banner below is ordinary markup, so both
  // work identically there — and the guard is what let a desktop fail to
  // push for a week while showing nothing at all.
  const refreshSyncHealth = async () => {
    const [{ getSyncPauseReason }, { getLastPushAt }, { getGitRemoteAccessProblem }] = await Promise.all([
      import('../lib/sync/androidMirror'),
      import('../lib/sync/gitSync'),
      import('../lib/sync/syncSettings'),
    ]);
    const [reason, pushedAt, problem] = await Promise.all([
      getSyncPauseReason(),
      getLastPushAt(),
      getGitRemoteAccessProblem(),
    ]);
    setPauseReason(reason);
    setLastPushAt(pushedAt);
    setAccessProblem(problem);
  };

  useEffect(() => {
    Promise.all([
      import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()),
      import('../lib/electronBridge').then(({ isElectron }) => isElectron()),
    ]).then(async ([isStandalone, isElectronApp]) => {
      setStandalone(isStandalone);
      setElectron(isElectronApp);
      if (!isStandalone) return;
      const { getActiveProfile } = await import('../lib/standalone');
      setIsAdmin((await getActiveProfile())?.role === 'admin');
      const { getLastSyncAt, getDeviceId, getDeviceName } = await import('../lib/sync/gitSync');
      const { getSyncMode, getGitRemoteConfig, getSyncInterval } = await import('../lib/sync/syncSettings');
      setLastSyncAt(await getLastSyncAt());
      await refreshSyncHealth();
      setDeviceId(await getDeviceId());
      const name = await getDeviceName();
      setDeviceNameState(name);
      setSavedDeviceName(name);
      const interval = await getSyncInterval();
      setIntervalValueState(interval.value);
      setIntervalUnitState(interval.unit);

      const mode = await getSyncMode();
      setSyncModeState(mode);
      const gitRemoteConfig = await getGitRemoteConfig();
      if (gitRemoteConfig) {
        setGitRemoteUrl(gitRemoteConfig.url);
        setGitRemoteUsername(gitRemoteConfig.username ?? '');
        setGitRemoteCorsProxy(gitRemoteConfig.corsProxy ?? '');
        setShowCorsProxy(!!gitRemoteConfig.corsProxy);
        setGitRemoteTokenConfigured(!!gitRemoteConfig.token);
      }

      if (mode === 'folder') {
        await refreshDevices();
        if (isElectronApp) {
          const { getElectronFolder } = await import('../lib/gitfs');
          setFolderPath(await getElectronFolder().catch(() => null));
        } else {
          const { getMirrorState, getSyncPauseReason } = await import('../lib/sync/androidMirror');
          const state = await getMirrorState();
          setFolderPath(state?.treeDisplayName ?? null);
          setPauseReason(await getSyncPauseReason());
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    setProgress(null);
    try {
      const { syncNow } = await import('../lib/sync/gitSync');
      const r = await syncNow((p) => setProgress(p));
      setResult(r);
      setLastSyncAt(r.lastSyncAt);
      if (syncMode === 'folder') await Promise.all([refreshDevices(), refreshSyncHealth()]);
      else await refreshSyncHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.syncFailed'));
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  };

  // A freshly (re-)chosen target has no way to know about rows this device
  // already had before Folder Sync (or this specific sync bug fix) ever
  // existed — normal create/update calls only ever touch the one row
  // involved, so nothing retroactively "catches up" an old row on its own.
  // Re-writing every local row's entity file here means picking a new
  // folder always leaves it correctly populated, not just newly-edited
  // rows — including recovering from a sync target that got wiped/
  // corrupted (as happened testing this against Google Drive earlier).
  // Reused for a git-remote mode switch/reconfigure too — a device newly
  // pointed at a different backend has exactly the same "does this target
  // already reflect everything I have" problem a new folder does.
  // onProgress fires after every single row across all six entity types —
  // a device with a large, never-before-pushed library (recipes especially,
  // each needing its own extra ingredients/steps/tools queries) can take a
  // real while here, with nothing else in the UI otherwise showing it's
  // doing anything until the push phase starts afterward.
  const resyncAllLocalData = async (onProgress?: (phase: string, done: number, total: number) => void) => {
    const [{ resyncAllRecipes }, { resyncAllIngredients, resyncAllTools }, { resyncAllProfiles }, { resyncAllTags }, { resyncAllTechniques }] = await Promise.all([
      import('../services/recipes.local'),
      import('../services/ingredients.local'),
      import('../services/profiles.local'),
      import('../services/tags.local'),
      import('../services/techniques.local'),
    ]);
    await resyncAllIngredients((done, total) => onProgress?.('ingredients', done, total));
    await resyncAllTools((done, total) => onProgress?.('tools', done, total));
    await resyncAllTags((done, total) => onProgress?.('tags', done, total));
    await resyncAllTechniques((done, total) => onProgress?.('techniques', done, total));
    await resyncAllRecipes((done, total) => onProgress?.('recipes', done, total));
    await resyncAllProfiles((done, total) => onProgress?.('profiles', done, total));
  };

  // Exposed as its own button (not just triggered implicitly by Change
  // Folder/Save & Sync) so a device that's already configured can force a
  // full re-serialize+push on demand — e.g. right after updating to a
  // build that fixed a resync gap (tags/techniques were missing entirely
  // until this same release), without needing to re-enter its Sync Folder
  // or Git Remote settings just to trigger one.
  const handleResyncAll = async () => {
    setResyncingAll(true);
    setError(null);
    setResyncProgress(null);
    try {
      await resyncAllLocalData((phase, done, total) => setResyncProgress({ phase, done, total }));
      setResyncProgress(null);
      await handleSyncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.couldNotResync'));
    } finally {
      setResyncingAll(false);
      setResyncProgress(null);
    }
  };

  // Recovers from a real, now-fixed bug: an entity's row could get created
  // successfully during a sync while its whole-array fields (steps/
  // ingredients/toolIds) silently failed to write (a global-id collision
  // in writeArrayField() — see gitSync.ts's repairLocalStorage() for the
  // full story). This device's own git history already has the correct
  // data; ordinary Sync Now won't re-trigger the write on its own once
  // there's nothing new from the remote side to pull, so this is the
  // actual fix, not "sync again" (which the failedEntities message below
  // used to suggest, before this button existed to do the right thing).
  const handleRepairLocalStorage = async () => {
    setRepairing(true);
    setError(null);
    setRepairMessage(null);
    try {
      const { repairLocalStorage } = await import('../lib/sync/gitSync');
      const outcome = await repairLocalStorage();
      setRepairMessage(
        outcome.repaired > 0
          ? `Repaired ${outcome.repaired} item${outcome.repaired === 1 ? '' : 's'} from this device's own sync history.`
          : "Nothing needed repair — this device's data already matches its own sync history."
      );
      if (outcome.failedEntities.length > 0) {
        setError(`${outcome.failedEntities.length} item(s) still couldn't be repaired — see the console for details.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.couldNotRepair'));
    } finally {
      setRepairing(false);
    }
  };

  const handleChangeFolder = async () => {
    setChoosingFolder(true);
    setError(null);
    try {
      const { pickAndPersistSyncFolder } = await import('../lib/syncFolderPicker');
      const picked = await pickAndPersistSyncFolder();
      if (picked) {
        if (electron) {
          const { resetSyncRepoInit } = await import('../lib/sync/gitSync');
          resetSyncRepoInit();
        }
        setFolderPath(picked.displayName);
        await resyncAllLocalData();
        await handleSyncNow();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.couldNotChangeFolder'));
    } finally {
      setChoosingFolder(false);
    }
  };

  const handleSaveDeviceName = async () => {
    const trimmed = deviceName.trim();
    if (!trimmed || trimmed === savedDeviceName) return;
    setSavingName(true);
    try {
      const { setDeviceName } = await import('../lib/sync/gitSync');
      await setDeviceName(trimmed);
      setSavedDeviceName(trimmed);
      await handleSyncNow(); // so devices/<id>.json and the list below reflect it right away
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.couldNotSaveDeviceName'));
    } finally {
      setSavingName(false);
    }
  };

  const handleSelectMode = async (mode: 'folder' | 'git-remote') => {
    setSyncModeState(mode);
    setError(null);
    setConnectionTestResult(null);
    const { setSyncMode } = await import('../lib/sync/syncSettings');
    await setSyncMode(mode);
    if (mode === 'folder' && folderPath) await handleSyncNow();
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setConnectionTestResult(null);
    try {
      const [{ probeGitRemoteAccess, persistableProblem }, { getGitRemoteConfig, setGitRemoteAccessProblem }] =
        await Promise.all([import('../lib/sync/remoteAccessProbe'), import('../lib/sync/syncSettings')]);
      // Falls back to the SAVED token when the field was left blank. Passing
      // null here — which is what this did — is how the button managed to
      // test anonymously and then report "credentials accepted" about a
      // token it had never sent.
      const saved = await getGitRemoteConfig();
      const result = await probeGitRemoteAccess({
        url: gitRemoteUrl.trim(),
        username: gitRemoteUsername.trim() || null,
        token: gitRemoteTokenTouched ? (gitRemoteToken.trim() || null) : (saved?.token ?? null),
        corsProxy: gitRemoteCorsProxy.trim() || null,
      });
      setConnectionTestResult(result);
      const problem = persistableProblem(result);
      await setGitRemoteAccessProblem(problem);
      setAccessProblem(problem);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveGitRemote = async () => {
    setSavingGitRemote(true);
    setError(null);
    try {
      const { setGitRemoteConfig } = await import('../lib/sync/syncSettings');
      await setGitRemoteConfig({
        url: gitRemoteUrl.trim(),
        username: gitRemoteUsername.trim() || null,
        // undefined (untouched) leaves whatever token is already saved
        // alone — same leave-blank-to-keep pattern as the AI Provider
        // card's API keys.
        token: gitRemoteTokenTouched ? (gitRemoteToken.trim() || null) : undefined,
        corsProxy: gitRemoteCorsProxy.trim() || null,
      });
      if (gitRemoteTokenTouched) {
        setGitRemoteTokenConfigured(!!gitRemoteToken.trim());
        setGitRemoteToken('');
        setGitRemoteTokenTouched(false);
      }
      await resyncAllLocalData();
      await handleSyncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.couldNotSaveGitRemote'));
    } finally {
      setSavingGitRemote(false);
    }
  };

  const handleSaveInterval = async (value: number, unit: SyncIntervalUnit) => {
    setSavingInterval(true);
    try {
      const { setSyncInterval, syncIntervalToMinutes } = await import('../lib/sync/syncSettings');
      const interval: SyncInterval = { value, unit };
      await setSyncInterval(interval);
      const { applySyncIntervalChange } = await import('../lib/sync/gitSync');
      applySyncIntervalChange(syncIntervalToMinutes(interval));
      setIntervalValueState(value);
      setIntervalUnitState(unit);
    } finally {
      setSavingInterval(false);
    }
  };

  if (!standalone) return null;

  // Non-admin profiles can still see sync status and trigger a manual sync
  // (that's just using the existing configuration), but changing WHERE this
  // library syncs to, its credentials, its interval, or device management
  // affects every device sharing this library — reserved for an admin.
  if (!isAdmin) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.folderSync.syncHeading')}</h2>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
              {lastSyncAt
                ? t('account.folderSync.lastSyncedAt', { when: new Date(lastSyncAt).toLocaleString() })
                : t('account.folderSync.neverSynced')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing}
            className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-2xl font-black text-sm hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${syncing ? 'animate-spin' : ''}`}>sync</span>
            {syncing ? t('account.folderSync.syncing') : t('account.folderSync.syncNow')}
          </button>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {t('account.folderSync.adminOnlyNote')}
        </p>
        {error && <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.folderSync.heading')}</h2>
          {/* Trans-free on purpose: the emphasis is decoration, and splitting
              the sentence into three translatable fragments to keep it would
              make the whole thing harder to translate than it is to read. */}
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
            {t('account.folderSync.subtitle')}{' '}
            {t('account.folderSync.subtitleCrossRef', { card: t('account.storageMode.heading') })}
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {pauseReason && (
          <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">warning</span>
            {t('account.folderSync.syncPaused', { reason: pauseReason })}
          </p>
        )}

        {/* Survives a reload and a restart, unlike pauseReason: a device
            that can read but not write never fails loudly enough to set
            one. */}
        <RemoteAccessNotice kind={accessProblem} />

        {/* Shown whether or not anything is currently failing: a push time
            that has stopped advancing is the durable signal, where the
            banner above only lasts until something clears it. */}
        {stalePush(lastSyncAt, lastPushAt) && (
          <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">cloud_off</span>
            <span>{t('account.folderSync.stalePush', { when: new Date(lastPushAt!).toLocaleString() })}</span>
          </p>
        )}

        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.syncMode')}</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSelectMode('folder')}
              className={`text-left p-4 rounded-2xl border transition-colors ${syncMode === 'folder' ? 'border-primary bg-primary/5' : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
              <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">{t('account.folderSync.modeFolder')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {electron
                  ? t('account.folderSync.modeFolderHintDesktop')
                  : t('account.folderSync.modeFolderHintAndroid')}
              </p>
            </button>
            <button
              type="button"
              onClick={() => handleSelectMode('git-remote')}
              className={`text-left p-4 rounded-2xl border transition-colors ${syncMode === 'git-remote' ? 'border-primary bg-primary/5' : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
              <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">{t('account.folderSync.modeGitRemote')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('account.folderSync.modeGitRemoteHint')}</p>
            </button>
          </div>
        </div>

        {syncMode === 'folder' ? (
          <div className="flex gap-8 flex-wrap">
            <div className="min-w-0">
              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.syncFolder')}</p>
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate max-w-xs" title={folderPath ?? undefined}>{folderPath ?? t('account.folderSync.noFolderChosen')}</p>
            </div>
            <div className="self-end">
              <button
                type="button"
                onClick={handleChangeFolder}
                disabled={choosingFolder}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-xl font-black text-xs hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">folder_open</span>
                {choosingFolder ? t('account.folderSync.choosing') : folderPath ? t('account.folderSync.changeFolder') : t('account.folderSync.chooseFolder')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.repositoryUrl')}</label>
              <input
                type="text"
                value={gitRemoteUrl}
                onChange={(e) => setGitRemoteUrl(e.target.value)}
                placeholder="https://github.com/you/smartchef-sync.git"
                className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
              />
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">
                {t('account.folderSync.repositoryUrlHint')}
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.username')}</label>
                <input
                  type="text"
                  value={gitRemoteUsername}
                  onChange={(e) => setGitRemoteUsername(e.target.value)}
                  placeholder={t('account.folderSync.usernamePlaceholder')}
                  className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                />
              </div>
              <ProviderKeyInput
                label={t('account.folderSync.accessToken')}
                placeholder={t('account.folderSync.accessTokenPlaceholder')}
                value={gitRemoteToken}
                hasKey={gitRemoteTokenConfigured}
                touched={gitRemoteTokenTouched}
                onChange={(v, t) => { setGitRemoteToken(v); setGitRemoteTokenTouched(t); }}
              />
              {/* Advisory only — Save stays enabled. See tokenShape.ts for
                  why a hard block would be the worse failure. */}
              {tokenShapeProblem && (
                <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[16px] shrink-0">warning</span>
                  {tokenShapeProblem.message}
                </p>
              )}
            </div>
            {showCorsProxy ? (
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.corsProxy')}</label>
                <input
                  type="text"
                  value={gitRemoteCorsProxy}
                  onChange={(e) => setGitRemoteCorsProxy(e.target.value)}
                  placeholder={t('account.folderSync.corsProxyPlaceholder')}
                  className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                />
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">
                  {t('account.folderSync.corsProxyHint')}
                </p>
              </div>
            ) : (
              <button type="button" onClick={() => setShowCorsProxy(true)} className="text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400">
                {t('account.folderSync.corsProxyToggle')}
              </button>
            )}
            {connectionTestResult && (
              <p className={`text-xs font-medium flex items-start gap-2 ${TEST_RESULT_TONE[connectionTestResult.kind]}`}>
                <span className="material-symbols-outlined text-[16px] shrink-0">{TEST_RESULT_ICON[connectionTestResult.kind]}</span>
                {connectionTestResult.message}
              </p>
            )}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testingConnection || !gitRemoteUrl.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 rounded-xl font-black text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-base ${testingConnection ? 'animate-spin' : ''}`}>wifi_tethering</span>
                {testingConnection ? t('account.folderSync.testing') : t('account.folderSync.testConnection')}
              </button>
              <button
                type="button"
                onClick={handleSaveGitRemote}
                disabled={savingGitRemote || !gitRemoteUrl.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl font-black text-xs hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">{savingGitRemote ? 'sync' : 'save'}</span>
                {savingGitRemote ? t('common.saving') : t('account.folderSync.saveAndSync')}
              </button>
            </div>
          </div>
        )}

        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.automaticSync')}</label>
          <div className="flex items-center gap-2 flex-wrap">
            {SYNC_INTERVAL_PRESETS.map((preset) => {
              const active = intervalValue === preset.value && intervalUnit === preset.unit;
              return (
                <button
                  key={`${preset.value}-${preset.unit}`}
                  type="button"
                  onClick={() => handleSaveInterval(preset.value, preset.unit)}
                  disabled={savingInterval}
                  className={`px-3 py-1.5 rounded-full text-xs font-black transition-colors disabled:opacity-50 ${active ? 'bg-zinc-900 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}
                >
                  {formatSyncInterval(preset)}
                </button>
              );
            })}
            <div className="flex items-center gap-1.5 ml-1">
              <input
                type="number"
                min={1}
                value={intervalValue}
                onChange={(e) => setIntervalValueState(Math.max(1, Number(e.target.value) || 1))}
                onBlur={() => handleSaveInterval(intervalValue, intervalUnit)}
                className="w-16 bg-zinc-50 dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold px-2 py-1.5 text-xs text-center"
              />
              <select
                value={intervalUnit}
                onChange={(e) => {
                  const unit = e.target.value as SyncIntervalUnit;
                  setIntervalUnitState(unit);
                  handleSaveInterval(intervalValue, unit);
                }}
                disabled={savingInterval}
                className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold px-2 py-1.5 text-xs disabled:opacity-50"
              >
                <option value="minutes">{t('account.folderSync.unitMinutes')}</option>
                <option value="hours">{t('account.folderSync.unitHours')}</option>
                <option value="days">{t('account.folderSync.unitDays')}</option>
                <option value="weeks">{t('account.folderSync.unitWeeks')}</option>
                <option value="months">{t('account.folderSync.unitMonths')}</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">{t('account.folderSync.automaticSyncHint')}</p>
        </div>

        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.setupFile.label')}</label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setExportingSetup(true)}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl font-black text-xs hover:bg-zinc-800 transition-all active:scale-[0.98]"
            >
              <span className="material-symbols-outlined text-base">lock</span>
              {t('account.setupFile.exportButton')}
            </button>
            <button
              type="button"
              onClick={() => { setSetupImported(null); setImportingSetup(true); }}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-xl font-black text-xs hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98]"
            >
              <span className="material-symbols-outlined text-base">upload_file</span>
              {t('account.setupFile.importButton')}
            </button>
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">
            {t('account.setupFile.hint')}
          </p>
          {setupImported && (
            <p className="text-xs font-bold text-primary mt-2">
              {t('account.setupFile.applied', {
                what: setupImported.mode === 'git-remote'
                  ? `${t('account.folderSync.modeGitRemote')} — ${setupImported.remoteUrl}`
                  : t('account.setupFile.appliedFolderMode'),
              })}
              {setupImported.needsSyncFolder && ` ${t('account.setupFile.appliedNeedsFolder')}`}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.deviceName')}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceNameState(e.target.value)}
              onBlur={handleSaveDeviceName}
              placeholder={deviceId ?? ''}
              className="flex-1 bg-zinc-50 dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
            />
            {savingName && <span className="material-symbols-outlined text-lg text-zinc-400 dark:text-zinc-500 animate-spin self-center">sync</span>}
          </div>
        </div>

        <div className="flex gap-8 flex-wrap self-end pb-1">
          <div>
            <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.thisDevice')}</p>
            <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{deviceId ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.lastSync')}</p>
            <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : t('account.folderSync.never')}</p>
          </div>
        </div>
        </div>

        {syncMode === 'folder' && devices.length > 0 && (
          <div>
            <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.knownDevices')}</p>
            <div className="space-y-1.5">
              {devices.map((d) => (
                <div key={d.deviceId} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 rounded-xl">
                  <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300">
                    {d.deviceName}
                    {d.deviceId === deviceId && <span className="text-zinc-400 dark:text-zinc-500 font-medium"> {t('account.folderSync.thisDeviceSuffix')}</span>}
                  </span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{formatRelativeTime(t, d.lastSyncAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {syncMode === 'git-remote' && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {t('account.folderSync.knownDevicesUnavailable')}
          </p>
        )}

        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        {resyncingAll && resyncProgress && (
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
              {t('account.folderSync.resyncProgress', { phase: resyncProgress.phase, done: resyncProgress.done, total: resyncProgress.total })}
            </p>
            <div className="h-1.5 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all bg-amber-500"
                style={{ width: `${resyncProgress.total ? Math.round((resyncProgress.done / resyncProgress.total) * 100) : 100}%` }}
              />
            </div>
          </div>
        )}
        {resyncingAll && !resyncProgress && !syncing && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">{t('account.folderSync.preparingResync')}</p>
        )}
        {syncing && progress && (
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
              {progress.phase === 'push' ? t('account.folderSync.uploading') : t('account.folderSync.downloading')}{' — '}
              {t('account.folderSync.objectProgress', { done: progress.done, count: progress.total })}
            </p>
            <div className="h-1.5 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${progress.phase === 'push' ? 'bg-primary' : 'bg-sky-500'}`}
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 100}%` }}
              />
            </div>
          </div>
        )}
        {!syncing && result && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
            {result.pushedObjects > 0 && `${t('account.folderSync.uploadedObjects', { count: result.pushedObjects })} `}
            {result.pulledObjects > 0 && `${t('account.folderSync.downloadedObjects', { count: result.pulledObjects })} `}
            {result.pushedObjects === 0 && result.pulledObjects === 0 && `${t('account.folderSync.nothingTransferred')} `}
            {result.applied > 0
              ? t('account.folderSync.appliedFromOthers', {
                  what: formatAppliedByType(t, result.appliedByType) || t('account.folderSync.changeCount', { count: result.applied }),
                })
              : t('account.folderSync.nothingNew')}
            {result.committed ? ` ${t('account.folderSync.ownChangesCommitted')}` : ''}
            {result.conflicts > 0 ? ` ${t('account.folderSync.fieldsNeedReview', { count: result.conflicts })}` : ''}
          </p>
        )}
        {!syncing && result && result.failedEntities.length > 0 && (
          <p className="text-xs text-red-600 font-medium">
            {t('account.folderSync.failedEntities', {
              count: result.failedEntities.length,
              types: result.failedEntities.map((f) => f.entityType).join(', '),
            })}
          </p>
        )}
        {!syncing && result && Object.keys(result.entityScanCounts).length > 0 && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
            {t('account.folderSync.scanCounts')} {formatScanCounts(result.entityScanCounts)}
          </p>
        )}
        {!repairing && repairMessage && <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">{repairMessage}</p>}

        <div className="flex gap-3 flex-wrap">
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${syncing ? 'animate-spin' : ''}`}>sync</span>
            {syncing ? t('account.folderSync.syncing') : t('account.folderSync.syncNow')}
          </button>
          <button
            type="button"
            onClick={handleResyncAll}
            disabled={resyncingAll || syncing}
            title={t('account.folderSync.resyncAllHint')}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${resyncingAll ? 'animate-spin' : ''}`}>refresh</span>
            {resyncingAll ? t('account.folderSync.resyncing') : t('account.folderSync.resyncAll')}
          </button>
          <button
            type="button"
            onClick={handleRepairLocalStorage}
            disabled={repairing || syncing || resyncingAll}
            title={t('account.folderSync.repairHint')}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${repairing ? 'animate-spin' : ''}`}>build</span>
            {repairing ? t('account.folderSync.repairing') : t('account.folderSync.repairLocalData')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/sync-history')}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg">history</span>
            {t('account.folderSync.history')}
          </button>
        </div>
      </div>

      <ExportSetupFileDialog
        open={exportingSetup}
        onClose={() => setExportingSetup(false)}
        deviceName={savedDeviceName || deviceId}
      />
      <ImportSetupFileDialog
        open={importingSetup}
        onClose={() => setImportingSetup(false)}
        onImported={(applied) => {
          setSetupImported(applied);
          void reloadSyncSettings();
        }}
      />
    </div>
  );
}

function OfflineDownloadsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    import('../lib/offlineStore').then(({ listDownloadedRecipes }) => listDownloadedRecipes()).then((r) => setCount(r.length)).catch(() => setCount(0));
  }, []);

  return (
    <button
      type="button"
      onClick={() => navigate('/downloads')}
      className="w-full flex items-center justify-between gap-4 bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-left hover:border-zinc-200 dark:hover:border-zinc-700 transition-colors"
    >
      <div>
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.offlineDownloads.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
          {count === null
            ? t('common.loading')
            : count === 0
              ? t('account.offlineDownloads.empty')
              : t('account.offlineDownloads.count', { count })}
        </p>
      </div>
      <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500">chevron_right</span>
    </button>
  );
}

function SyncCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await apiFetch('/api/sync-folder/status');
      const json = await res.json();
      if (res.ok) setStatus(json.data);
    } catch {
      // best-effort — leave status as-is
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sync-folder/sync-now', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('account.folderSync.syncFailed'));
      setLastSummary(json.data.imported);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.folderSync.syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  if (!status) return null;

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.multiDeviceSync.heading')}</h2>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
            {status.enabled
              ? t('account.multiDeviceSync.enabledSubtitle')
              : t('account.multiDeviceSync.disabledSubtitle')}
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${status.enabled ? 'bg-primary/10 text-primary' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'}`}>
          {status.enabled ? t('account.multiDeviceSync.enabled') : t('account.multiDeviceSync.disabled')}
        </span>
      </div>

      {status.enabled && (
        <div className="space-y-5">
          <div className="flex gap-8">
            <div>
              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.thisDevice')}</p>
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{status.deviceName}</p>
            </div>
            <div>
              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('account.folderSync.lastSync')}</p>
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{status.lastSyncAt ? formatRelativeTime(t, status.lastSyncAt) : t('account.folderSync.never')}</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.knownDevices')}</p>
            {!status.peers || status.peers.length === 0 ? (
              <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('account.multiDeviceSync.noPeers')}</p>
            ) : (
              <div className="space-y-1.5">
                {status.peers.map((p) => (
                  <div key={p.deviceId} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 rounded-xl">
                    <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300">{p.deviceName}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">{formatRelativeTime(t, p.lastSeenAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${syncing ? 'animate-spin' : ''}`}>sync</span>
            {syncing ? t('account.folderSync.syncing') : t('account.folderSync.syncNow')}
          </button>
          {lastSummary && <SyncSummaryPanel summary={lastSummary} />}
        </div>
      )}
    </div>
  );
}

interface LlmConfig {
  provider: string;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  ollamaUrl: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
};

// One config field per provider — an API key for the three cloud
// providers, or a base URL for local Ollama (host/port, e.g. when it's
// running on another machine on the LAN rather than this one). Keeping
// this in one place is what makes the card below "one relevant field,
// however the provider needs it configured" instead of every provider's
// key sitting on screen regardless of which one is actually selected.
const PROVIDER_KEY_META: Record<string, { labelKey: string; placeholder: string }> = {
  anthropic: { labelKey: 'account.llm.keyAnthropic', placeholder: 'sk-ant-...' },
  gemini: { labelKey: 'account.llm.keyGemini', placeholder: 'AIza...' },
  openai: { labelKey: 'account.llm.keyOpenai', placeholder: 'sk-...' },
};

function ProviderKeyInput({
  label, placeholder, value, hasKey, touched, onChange,
}: {
  label: string; placeholder: string; value: string; hasKey: boolean; touched: boolean;
  onChange: (value: string, touched: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{label}</label>
      <div className="relative">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value, true)}
          placeholder={hasKey && !touched ? t('account.llm.keyConfigured') : placeholder}
          className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4 pr-24"
        />
        {hasKey && !touched && (
          <button
            type="button"
            onClick={() => onChange('', true)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-red-600 transition-colors"
          >
            {t('account.llm.removeKey')}
          </button>
        )}
      </div>
    </div>
  );
}

const PROVIDER_KEY_STATE_KEYS = ['anthropic', 'gemini', 'openai'] as const;
type CloudProvider = (typeof PROVIDER_KEY_STATE_KEYS)[number];

function LlmProviderCard() {
  const { t } = useTranslation();
  const [provider, setProvider] = useState('ollama');
  const [hasKey, setHasKey] = useState<Record<CloudProvider, boolean>>({ anthropic: false, gemini: false, openai: false });
  const [keyValue, setKeyValue] = useState<Record<CloudProvider, string>>({ anthropic: '', gemini: '', openai: '' });
  const [keyTouched, setKeyTouched] = useState<Record<CloudProvider, boolean>>({ anthropic: false, gemini: false, openai: false });
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [savedOllamaUrl, setSavedOllamaUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/llm-config')
      .then((res) => res.json())
      .then((json: { data?: LlmConfig }) => {
        if (json.data) {
          setProvider(json.data.provider);
          setHasKey({ anthropic: json.data.hasAnthropicKey, gemini: json.data.hasGeminiKey, openai: json.data.hasOpenaiKey });
          setOllamaUrl(json.data.ollamaUrl ?? '');
          setSavedOllamaUrl(json.data.ollamaUrl ?? '');
        }
      })
      // Not swallowed: a failure here used to leave the card silently
      // showing its defaults (provider "ollama", no key) as if that were
      // the saved configuration, so the only sign anything was wrong came
      // later, from Save.
      .catch((err) => setError(err instanceof Error ? err.message : t('account.llm.couldNotLoad')))
      .finally(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = { llmProvider: provider };
      for (const p of PROVIDER_KEY_STATE_KEYS) {
        if (keyTouched[p]) body[`${p}ApiKey`] = keyValue[p];
      }
      if (ollamaUrl !== savedOllamaUrl) body.ollamaUrl = ollamaUrl;
      const res = await apiFetch('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('common.failedToSave'));
      setHasKey((prev) => {
        const next = { ...prev };
        for (const p of PROVIDER_KEY_STATE_KEYS) if (keyTouched[p]) next[p] = !!keyValue[p];
        return next;
      });
      setKeyValue((prev) => {
        const next = { ...prev };
        for (const p of PROVIDER_KEY_STATE_KEYS) if (keyTouched[p]) next[p] = '';
        return next;
      });
      setKeyTouched({ anthropic: false, gemini: false, openai: false });
      setSavedOllamaUrl(ollamaUrl);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  const cloudProvider = provider !== 'ollama' ? (provider as CloudProvider) : null;

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.llm.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
          {t('account.llm.subtitle')}
        </p>
      </div>

      <div className="space-y-5">
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.llm.provider')}</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4 appearance-none cursor-pointer"
          >
            <option value="ollama">{t('account.llm.providerOllama')}</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="gemini">Google (Gemini)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </div>

        {cloudProvider && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">info</span>
            {t('account.llm.cloudWarning', { provider: PROVIDER_LABELS[provider] })}
          </p>
        )}

        {/* Exactly one config field, matching whichever provider is selected above —
            an API key for a cloud provider, a base URL for local Ollama — rather than
            showing all four regardless of what's actually in use. */}
        {cloudProvider ? (
          <ProviderKeyInput
            label={t(PROVIDER_KEY_META[cloudProvider].labelKey)}
            placeholder={PROVIDER_KEY_META[cloudProvider].placeholder}
            value={keyValue[cloudProvider]}
            hasKey={hasKey[cloudProvider]}
            touched={keyTouched[cloudProvider]}
            onChange={(v, t) => {
              setKeyValue((prev) => ({ ...prev, [cloudProvider]: v }));
              setKeyTouched((prev) => ({ ...prev, [cloudProvider]: t }));
            }}
          />
        ) : (
          <div>
            <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.llm.ollamaUrl')}</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder={t('account.llm.ollamaUrlPlaceholder')}
              className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
            />
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
              {t('account.llm.ollamaUrlHint')}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-lg">{saving ? 'sync' : saved ? 'check' : 'save'}</span>
          {saving ? t('common.saving') : saved ? t('common.saved') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

function ManageUsersCard() {
  const { t } = useTranslation();
  return (
    <Link
      to="/manage-users"
      className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 hover:border-zinc-200 dark:hover:border-zinc-700 transition-colors"
    >
      <div>
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.manageUsers.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('account.manageUsers.subtitle')}</p>
      </div>
      <span className="material-symbols-outlined text-zinc-300 dark:text-zinc-600">chevron_right</span>
    </Link>
  );
}

function BackupCard() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/backup/export', { timeoutMs: 120_000 });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('account.backup.exportFailed'));
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smartchef-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.backup.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const handleRestoreFile = async (file: File) => {
    setRestoring(true);
    setError(null);
    setLastSummary(null);
    try {
      const text = await file.text();
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(text);
      } catch {
        throw new Error(t('account.backup.notValidJson'));
      }
      const res = await apiFetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
        timeoutMs: 60_000,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('account.backup.restoreFailed'));
      setLastSummary(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.backup.restoreFailed'));
    } finally {
      setRestoring(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.backup.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
          {t('account.backup.subtitle')}
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
        >
          <span className={`material-symbols-outlined text-lg ${exporting ? 'animate-spin' : ''}`}>
            {exporting ? 'sync' : 'download'}
          </span>
          {exporting ? t('account.backup.exporting') : t('account.backup.exportButton')}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={restoring}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-2xl font-black text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98] disabled:opacity-50"
        >
          <span className={`material-symbols-outlined text-lg ${restoring ? 'animate-spin' : ''}`}>
            {restoring ? 'sync' : 'upload_file'}
          </span>
          {restoring ? t('account.backup.restoring') : t('account.backup.restoreButton')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleRestoreFile(f); }}
        />
      </div>

      {error && <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>}
      {lastSummary && <SyncSummaryPanel summary={lastSummary} />}
    </div>
  );
}

function StandaloneProfileCard() {
  const { t } = useTranslation();
  const setAccount = useStore((s) => s.setAccount);
  const account = useStore((s) => s.account);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [savedAvatarUrl, setSavedAvatarUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    import('../lib/standalone').then(({ getActiveProfile }) => getActiveProfile()).then((profile) => {
      setName(profile?.name ?? '');
      setSavedName(profile?.name ?? '');
      setAvatarUrl(profile?.avatarUrl ?? '');
      setSavedAvatarUrl(profile?.avatarUrl ?? '');
    });
  }, []);

  const dirty = name.trim() !== savedName || avatarUrl !== savedAvatarUrl;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const { setStandaloneName, setStandaloneAvatar } = await import('../lib/standalone');
      if (trimmed !== savedName) await setStandaloneName(trimmed);
      if (avatarUrl !== savedAvatarUrl) await setStandaloneAvatar(avatarUrl);
      setSavedName(trimmed);
      setSavedAvatarUrl(avatarUrl);
      if (account) setAccount({ ...account, name: trimmed, avatarUrl: avatarUrl || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.profile.couldNotSaveName'));
    } finally {
      setSaving(false);
    }
  };

  // Signing out drops to the "who's cooking?" picker (ProfilePicker.tsx),
  // where you pick another profile or make a new one — it keeps standalone
  // mode, the local library and the Sync Folder exactly as they are, and
  // only clears which profile *this device* is currently using.
  //
  // This used to call clearStandaloneProfile(), which also forgets that the
  // device is in offline mode at all — so signing out threw you back to
  // first-run's "Connect to a server / Use offline on this device" screen
  // and made every sign-out look like a decision about where your library
  // lives. That decision is now an admin one, made once, in StorageModeCard
  // below.
  const handleLogout = async () => {
    const { clearActiveProfile } = await import('../lib/standalone');
    await clearActiveProfile();
    window.location.href = '/';
  };

  return (
    <form onSubmit={handleSave} className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 space-y-6">
      <div>
        <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.name')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
        />
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
          {t('account.profile.noPasswordHint')}
        </p>
      </div>
      <div>
        <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.avatar')}</label>
        {AVATAR_PRESETS.length > 0 && (
          <div className="flex flex-wrap gap-3 mb-4">
            {AVATAR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAvatarUrl(preset)}
                className={`w-12 h-12 rounded-full overflow-hidden shrink-0 transition-all ${avatarUrl === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200 dark:hover:ring-zinc-700'}`}
              >
                <img src={preset} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <span className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.ownImage')}</span>
        <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} />
      </div>
      {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      <div className="flex gap-4 pt-2">
        <button
          type="submit"
          disabled={saving || !name.trim() || !dirty}
          className="px-8 py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-lg">{saving ? 'sync' : saved ? 'check' : 'save'}</span>
          {saving ? t('common.saving') : saved ? t('common.saved') : t('account.profile.saveChanges')}
        </button>
        <button
          type="button"
          onClick={handleLogout}
          title={t('account.profile.logOutHint')}
          className="px-6 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98]"
        >
          {t('account.profile.logOut')}
        </button>
      </div>
    </form>
  );
}

/** Admin-only list of every profile on this shared library — promote/demote
 *  and delete, mirroring server mode's ManageUsersCard/ManageUsers.tsx.
 *  Renders nothing for a non-admin active profile (same gating pattern as
 *  `{!standalone && account?.role === 'admin' && <ManageUsersCard />}` below). */
function AllProfilesCard() {
  const { t } = useTranslation();
  const [activeProfile, setActiveProfile] = useState<StandaloneProfile | null>(null);
  const [profiles, setProfiles] = useState<StandaloneProfile[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AVATAR);
  const [creating, setCreating] = useState(false);

  const reload = () => {
    import('../lib/standalone').then(async ({ getActiveProfile, listStandaloneProfiles }) => {
      setActiveProfile(await getActiveProfile());
      setProfiles(await listStandaloneProfiles());
    });
  };

  useEffect(() => { reload(); }, []);

  if (activeProfile?.role !== 'admin') return null;

  const handlePromote = async (p: StandaloneProfile, role: 'admin' | 'user') => {
    setBusyId(p.id);
    setError(null);
    try {
      const { setProfileRole } = await import('../lib/standalone');
      await setProfileRole(p.id, role);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.profiles.couldNotChangeRole'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (p: StandaloneProfile) => {
    if (!window.confirm(t('account.profiles.confirmRemove', { name: p.name }))) return;
    setBusyId(p.id);
    setError(null);
    try {
      const { removeProfile } = await import('../lib/standalone');
      await removeProfile(p.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.profiles.couldNotRemove'));
    } finally {
      setBusyId(null);
    }
  };

  // Adds the profile to the shared library without switching this device
  // to it — see createLibraryProfile() in lib/standalone.ts.
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const { createLibraryProfile } = await import('../lib/standalone');
      await createLibraryProfile(trimmed, newAvatar || null);
      setNewName('');
      setNewAvatar(DEFAULT_AVATAR);
      setAdding(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.profiles.couldNotCreate'));
    } finally {
      setCreating(false);
    }
  };

  const otherAdmins = (profiles ?? []).filter((p) => p.role === 'admin').length;

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.profiles.heading')}</h2>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('account.profiles.subtitle')}</p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => { setError(null); setAdding(true); }}
            className="flex items-center gap-1.5 shrink-0 px-4 py-2 bg-primary text-white rounded-full text-xs font-black hover:bg-primary/90 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">person_add</span>
            {t('account.profiles.addProfile')}
          </button>
        )}
      </div>
      {adding && (
        <form onSubmit={handleCreate} className="sc-panel p-5 mb-4 space-y-4">
          <div>
            <label className="sc-label mb-2">{t('account.profile.name')}</label>
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('account.profiles.namePlaceholder')}
              className="sc-field-inset"
            />
            <p className="sc-hint mt-2">
              {t('account.profiles.addHint')}
            </p>
          </div>
          <div>
            <label className="sc-label mb-2">{t('account.profile.avatar')}</label>
            {AVATAR_PRESETS.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {AVATAR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setNewAvatar(preset)}
                    className={`w-10 h-10 rounded-full overflow-hidden shrink-0 transition-all ${newAvatar === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200 dark:hover:ring-zinc-700'}`}
                  >
                    <img src={preset} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <ImageUrlInput value={newAvatar} onChange={setNewAvatar} />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setAdding(false); setNewName(''); setError(null); }}
              className="flex-1 py-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="flex-[2] py-3 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {creating ? t('account.profiles.adding') : t('account.profiles.addProfile')}
            </button>
          </div>
        </form>
      )}

      {profiles === null ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('common.loading')}</p>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => {
            const isSelf = p.id === activeProfile.id;
            const isLastAdmin = p.role === 'admin' && otherAdmins <= 1;
            return (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl">
                <span className="w-8 h-8 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-700 shrink-0 flex items-center justify-center">
                  {p.avatarUrl ? (
                    <ResolvedImage src={p.avatarUrl} className="w-full h-full object-cover" />
                  ) : (
                    <span className="material-symbols-outlined text-sm text-zinc-400 dark:text-zinc-500">person</span>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{p.name}{isSelf ? ` ${t('account.profiles.youSuffix')}` : ''}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shrink-0 ${p.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'}`}>
                  {p.role === 'admin' ? t('account.profiles.roleAdmin') : t('account.profiles.roleUser')}
                </span>
                {!isSelf && (
                  <button
                    type="button"
                    onClick={() => handlePromote(p, p.role === 'admin' ? 'user' : 'admin')}
                    disabled={busyId === p.id || (p.role === 'admin' && isLastAdmin)}
                    title={
                      p.role === 'admin' && isLastAdmin
                        ? t('account.profiles.cannotDemoteLastAdmin')
                        : p.role === 'admin'
                          ? t('account.profiles.demoteHint', { name: p.name })
                          : t('account.profiles.promoteHint', { name: p.name })
                    }
                    className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[10px] font-black uppercase tracking-widest hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0 disabled:opacity-50"
                  >
                    {busyId === p.id ? '…' : p.role === 'admin' ? t('account.profiles.demote') : t('account.profiles.promote')}
                  </button>
                )}
                {!isSelf && (
                  <button
                    type="button"
                    onClick={() => handleDelete(p)}
                    disabled={busyId === p.id || (p.role === 'admin' && isLastAdmin)}
                    title={p.role === 'admin' && isLastAdmin ? t('account.profiles.cannotDeleteLastAdmin') : t('account.profiles.removeHint', { name: p.name })}
                    className="w-8 h-8 rounded-full bg-red-50 text-red-400 flex items-center justify-center hover:bg-red-100 transition-colors shrink-0 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-sm">{busyId === p.id ? 'sync' : 'delete'}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>}
    </div>
  );
}


/** Where this device keeps the library — offline SQLite, or a SmartChef
 *  server — and the only place that choice can be changed after first run.
 *
 *  Admin-only and native-only. It used to be re-asked implicitly, by
 *  signing out: standalone's Log Out cleared the "this device is offline"
 *  flag and dropped everyone back on the first-run chooser, so a decision
 *  about where a household's whole library lives sat behind a button any
 *  user pressed to hand the tablet to someone else. Sign-out now just
 *  returns to the profile picker; moving the library is this card, and it
 *  copies the data across instead of silently leaving it behind. */
function StorageModeCard() {
  const { t } = useTranslation();
  const account = useStore((s) => s.account);
  const [standalone, setStandalone] = useState<boolean | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  const [mode, setMode] = useState<'idle' | 'toServer' | 'toOffline' | 'done'>('idle');
  const [url, setUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);

  useEffect(() => {
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setStandalone);
    getServerUrl().then(setServerUrlState);
  }, []);

  // Web has neither a local SQLite library nor a configurable server URL,
  // so there is nothing to move between.
  if (!isNative() || standalone === null) return null;
  if (account?.role !== 'admin') return null;

  const reset = () => {
    setMode('idle');
    setError(null);
    setStage(null);
    setPassword('');
    setSummary(null);
  };

  // Full reload rather than a state update: which backend apiFetch talks to
  // is decided once at App.tsx boot, and every page still mounted is
  // holding data from the old one. Deliberately NOT automatic — the switch
  // has already happened by this point, and the summary of what moved is
  // worth reading before the app restarts underneath it.
  const finish = () => { window.location.href = '/'; };

  const run = async (migrate: () => Promise<MigrationSummary>) => {
    setBusy(true);
    setError(null);
    try {
      setSummary((await migrate()) as SyncSummary);
      setMode('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.storageMode.couldNotMove'));
    } finally {
      setStage(null);
      setBusy(false);
    }
  };

  const handleToServer = async (e: React.FormEvent) => {
    e.preventDefault();
    const { migrateOfflineToServer } = await import('../lib/storageMigration');
    await run(() => migrateOfflineToServer({ url, username, password, onStage: setStage }));
  };

  const handleToOffline = async () => {
    const { migrateServerToOffline } = await import('../lib/storageMigration');
    await run(() => migrateServerToOffline({ onStage: setStage }));
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.storageMode.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
          {t('account.storageMode.subtitle')}
        </p>
      </div>

      <div className="flex items-center gap-3 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 mb-6">
        <span className="material-symbols-outlined text-primary">{standalone ? 'smartphone' : 'dns'}</span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            {standalone ? t('account.storageMode.currentOffline') : t('account.storageMode.currentServer')}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">
            {standalone ? t('account.storageMode.currentOfflineHint') : (serverUrl || t('account.storageMode.thisOrigin'))}
          </p>
        </div>
      </div>

      {mode === 'idle' && (
        <button
          type="button"
          onClick={() => { setError(null); setMode(standalone ? 'toServer' : 'toOffline'); }}
          className="flex items-center gap-2 px-6 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-2xl font-black text-sm hover:opacity-90 transition-all active:scale-[0.98]"
        >
          <span className="material-symbols-outlined text-lg">swap_horiz</span>
          {standalone ? t('account.storageMode.moveToServer') : t('account.storageMode.moveToOffline')}
        </button>
      )}

      {mode === 'toServer' && (
        <form onSubmit={handleToServer} className="sc-panel p-5 space-y-4">
          <p className="sc-hint">{t('account.storageMode.toServerHint')}</p>
          <div>
            <label className="sc-label mb-2">{t('account.storageMode.serverAddress')}</label>
            <input
              type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://smartchef.your-tailnet.ts.net"
              autoCapitalize="none" className="sc-field-inset"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="sc-label mb-2">{t('account.folderSync.username')}</label>
              <input
                type="text" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())}
                autoCapitalize="none" className="sc-field-inset"
              />
            </div>
            <div>
              <label className="sc-label mb-2">{t('account.storageMode.password')}</label>
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="sc-field-inset"
              />
            </div>
          </div>
          <p className="sc-hint">{t('account.storageMode.photosNote')}</p>
          <div className="flex gap-3">
            <button
              type="button" onClick={reset} disabled={busy}
              className="flex-1 py-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit" disabled={busy || !url.trim() || !username.trim() || !password}
              className="flex-[2] py-3 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? (stage ?? t('account.storageMode.moving')) : t('account.storageMode.copyAndSwitch')}
            </button>
          </div>
        </form>
      )}

      {mode === 'toOffline' && (
        <div className="sc-panel p-5 space-y-4">
          <p className="sc-hint">{t('account.storageMode.toOfflineHint')}</p>
          <div className="flex gap-3">
            <button
              type="button" onClick={reset} disabled={busy}
              className="flex-1 py-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button" onClick={handleToOffline} disabled={busy}
              className="flex-[2] py-3 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? (stage ?? t('account.storageMode.moving')) : t('account.storageMode.copyAndSwitch')}
            </button>
          </div>
        </div>
      )}

      {mode === 'done' && (
        <div className="sc-panel p-5 space-y-4">
          <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            {standalone ? t('account.storageMode.doneOnServer') : t('account.storageMode.doneOffline')}
          </p>
          {summary && <SyncSummaryPanel summary={summary} />}
          <button
            type="button"
            onClick={finish}
            className="w-full py-3 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]"
          >
            {t('account.storageMode.restart')}
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>}
    </div>
  );
}

const THEME_OPTIONS: { mode: ThemeMode; labelKey: string; icon: string }[] = [
  { mode: 'light', labelKey: 'account.appearance.light', icon: 'light_mode' },
  { mode: 'dark', labelKey: 'account.appearance.dark', icon: 'dark_mode' },
  { mode: 'system', labelKey: 'account.appearance.system', icon: 'contrast' },
];

function AppearanceCard() {
  const { t } = useTranslation();
  const themeMode = useStore((s) => s.themeMode);
  const setThemeMode = useStore((s) => s.setThemeMode);

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.appearance.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('account.appearance.subtitle')}</p>
      </div>
      <div className="flex gap-2 bg-zinc-50 dark:bg-zinc-950 rounded-2xl p-1.5">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            onClick={() => setThemeMode(opt.mode)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-black text-xs transition-all ${
              themeMode === opt.mode
                ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">{opt.icon}</span>
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function LanguagesCard() {
  const { t, i18n } = useTranslation();
  const { languages, add, remove } = useLanguages();
  const contentLang = useStore((s) => s.contentLang);
  const setContentLang = useStore((s) => s.setContentLang);
  const accountId = useStore((s) => s.account?.id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The header picker moves the interface and the content language together,
  // which is the right default for the common case. This is the escape
  // hatch for the case it doesn't cover: reading recipes in one language
  // while keeping the app's own chrome in another. Stored per account
  // (lib/uiLanguage.ts), so two profiles sharing a device each keep theirs.
  const uiLang = languages.some((l) => l.hasUiBundle && l.code === i18n.language)
    ? i18n.language
    : 'en';

  const handleUiLangChange = (code: string) => {
    if (!persistUiLang(code, accountId)) return;
    void i18n.changeLanguage(code);
  };

  const custom = languages.filter((l) => !l.hasUiBundle);
  const preview = isValidLanguageCode(draft) ? languageLabel(draft) : null;

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const code = draft.trim();
    if (!code) return;
    if (!isValidLanguageCode(code)) {
      setError(t('languages.invalidCode'));
      return;
    }
    add(code);
    setDraft('');
    setError(null);
  };

  const handleRemove = (code: string) => {
    // Removing the language currently being read would leave every screen
    // asking the backend for a language no longer in the picker, so fall
    // back to English first.
    if (normalizeLanguageCode(code) === normalizeLanguageCode(contentLang)) setContentLang('en');
    remove(code);
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('languages.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('languages.subtitle')}</p>
      </div>

      <div className="mb-6">
        <label htmlFor="ui-language" className="sc-label mb-2 block">{t('languages.interfaceLabel')}</label>
        <select
          id="ui-language"
          value={uiLang}
          onChange={(e) => handleUiLangChange(e.target.value)}
          className="w-full sm:max-w-xs border-none bg-zinc-50 dark:bg-zinc-950 rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20"
        >
          {languages.filter((l) => l.hasUiBundle).map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-2 leading-relaxed">
          {t('languages.interfaceHint')}
        </p>
      </div>

      <p className="sc-label mb-2">{t('languages.contentHeading')}</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {languages.map((l) => (
          <span
            key={l.code}
            className={`inline-flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full text-xs font-bold border ${
              l.hasUiBundle
                ? 'bg-zinc-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'
                : 'bg-primary/8 text-primary border-primary/20'
            }`}
          >
            {l.label}
            <span className="opacity-50 font-mono text-[10px] uppercase">{l.code}</span>
            {l.hasUiBundle ? (
              <span title={t('languages.bundledHint')} className="material-symbols-outlined text-[14px] opacity-50">lock</span>
            ) : (
              <button
                type="button"
                onClick={() => handleRemove(l.code)}
                title={t('languages.remove')}
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-primary/15 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </span>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-[180px]">
          <input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            placeholder={t('languages.codePlaceholder')}
            aria-label={t('languages.addLabel')}
            className="w-full border-none bg-zinc-50 dark:bg-zinc-950 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-primary/20"
          />
          {/* Resolving the name as they type is what makes a bare code
              trustworthy — you can see "pt" really is Portuguese before adding it. */}
          {preview && !error && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-1.5 px-1">{preview}</p>
          )}
          {error && <p className="text-xs text-red-500 font-bold mt-1.5 px-1">{error}</p>}
        </div>
        <button
          type="submit"
          disabled={!draft.trim()}
          className="px-5 py-3 bg-primary text-white rounded-xl font-bold text-sm disabled:opacity-40 transition-all active:scale-95"
        >
          {t('languages.add')}
        </button>
      </form>

      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-4 leading-relaxed">
        {t('languages.note')}
      </p>
    </div>
  );
}

export default function Account() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const account = useStore((s) => s.account);
  const setAccount = useStore((s) => s.setAccount);
  const [standalone, setStandalone] = useState<boolean | null>(null);

  useEffect(() => {
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setStandalone);
  }, []);

  const [name, setName] = useState(account?.name ?? '');
  const [username, setUsername] = useState(account?.username ?? '');
  const [avatarUrl, setAvatarUrl] = useState(account?.avatarUrl ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = { name, avatarUrl: avatarUrl || null };
      if (username !== account?.username) body.username = username;
      if (password) body.password = password;
      const res = await apiFetch('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('common.failedToSave'));
      if (account) setAccount({ ...account, name, username: username.toLowerCase(), avatarUrl: avatarUrl || undefined });
      setPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setAccount(null);
    window.location.href = '/';
  };

  return (
    <AppLayout>
      <div className="px-6 sm:px-10 py-10 max-w-7xl mx-auto">
        <div className="mb-10">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('common.back')}
          </button>
          <h1 className="text-4xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter">{t('common.account')}</h1>
        </div>

      {/* Identity spans the full width: the avatar picker is fourteen
          swatches across and only reads as a row when it has the room. */}
      {standalone === null ? null : standalone ? (
        <StandaloneProfileCard />
      ) : (
      <form onSubmit={handleSave} className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 space-y-6">
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
          />
        </div>
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.folderSync.username')}</label>
          <input
            type="text"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
          />
        </div>
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.avatar')}</label>
          <div className="flex flex-wrap gap-3 mb-4">
            {AVATAR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAvatarUrl(preset)}
                className={`w-12 h-12 rounded-full overflow-hidden shrink-0 transition-all ${avatarUrl === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200 dark:hover:ring-zinc-700'}`}
              >
                <img src={preset} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
          <span className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.profile.ownImage')}</span>
          <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} />
        </div>
        <div>
          <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('account.serverAccount.newPassword')}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
          />
        </div>
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        <div className="flex gap-4 pt-2">
          <button
            type="submit"
            disabled={saving || !name}
            className="px-8 py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">{saving ? 'sync' : saved ? 'check' : 'save'}</span>
            {saving ? t('common.saving') : saved ? t('common.saved') : t('account.profile.saveChanges')}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="px-6 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all active:scale-[0.98]"
          >
            {t('account.profile.logOut')}
          </button>
        </div>
      </form>
      )}

      {/* Two packed stacks, not a two-column grid. CSS grid locks cards into
          rows, so the short Appearance card sitting beside the tall AI
          Provider left ~250px of dead space beneath it, and pushed Backup &
          Restore into a row of its own with the entire right half empty.
          Stacks just pack: each column is as tall as its own contents.

          The split is by content width, not importance — sync, conflicts and
          user management carry wide rows (repo URLs, device lists, diffs);
          appearance, provider, backup and the profile list are all short
          controls that read fine in a 490px column. */}
      <div className="mt-8 grid grid-cols-1 xl:grid-cols-12 gap-6 sm:gap-8 items-start">
        <div className="xl:col-span-7 space-y-6 sm:space-y-8 min-w-0">
          <FolderSyncCard />
          <SyncCard />
          {standalone && <ConflictsCard />}
          {isNative() && !standalone && <OfflineDownloadsCard />}
          {!standalone && account?.role === 'admin' && <ManageUsersCard />}
        </div>
        <div className="xl:col-span-5 space-y-6 sm:space-y-8 min-w-0">
          <AppearanceCard />
          <LanguagesCard />
          <LlmProviderCard />
          <BackupCard />
          {standalone && <AllProfilesCard />}
          <StorageModeCard />
        </div>
      </div>
      </div>
    </AppLayout>
  );
}
