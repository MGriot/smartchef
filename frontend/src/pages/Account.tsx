import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import ImageUrlInput from '../components/ImageUrlInput';
import { useStore } from '../store/app.store';
import { apiFetch, isNative } from '../lib/api';
import { AVATAR_PRESETS } from '../lib/avatarPresets';
import type { SyncResult } from '../lib/sync/gitSync';
import type { TransferProgress } from '../lib/sync/gitObjectTransport';
import type { SyncInterval, SyncIntervalUnit } from '../lib/sync/syncSettings';

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

const SYNC_SUMMARY_LABELS: Record<keyof Omit<SyncSummary, 'conflicts'>, string> = {
  categories: 'categories', tools: 'tools', techniques: 'techniques', tags: 'tags',
  ingredients: 'ingredients', recipes: 'recipes',
};

function SyncSummaryPanel({ summary }: { summary: SyncSummary }) {
  const changes = (Object.keys(SYNC_SUMMARY_LABELS) as Array<keyof typeof SYNC_SUMMARY_LABELS>)
    .map((key) => ({ key, count: summary[key], label: SYNC_SUMMARY_LABELS[key] }))
    .filter((c) => c.count > 0);

  return (
    <div className="mt-4 p-4 bg-zinc-50 rounded-2xl space-y-2">
      {changes.length === 0 && (summary.conflicts ?? []).length === 0 ? (
        <p className="text-xs text-zinc-400 font-medium">Nothing changed — already up to date.</p>
      ) : (
        <>
          {changes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {changes.map((c) => (
                <span key={c.key} className="px-2.5 py-1 bg-white border border-zinc-200 rounded-lg text-[11px] font-bold text-zinc-600">
                  {c.count} {c.label}
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

const ENTITY_TYPE_LABEL_PLURAL: Record<string, string> = {
  recipe: 'recipes', ingredient: 'ingredients', tool: 'tools', tag: 'tags', technique: 'techniques', profile: 'profiles',
};

/** "3 recipes, 5 ingredients" — the "which type" half of what a sync cycle
 *  pulled in, since a bare count doesn't say whether it was recipes,
 *  ingredients, or something else. Empty string (not "0 changes") when
 *  there's nothing to break down, so callers fall back to a plain count. */
function formatAppliedByType(byType: Partial<Record<string, number>>): string {
  return Object.entries(byType)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([type, count]) => `${count} ${count === 1 ? type : (ENTITY_TYPE_LABEL_PLURAL[type] ?? `${type}s`)}`)
    .join(', ');
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
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

function conflictValuePreview(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return String(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function ConflictFieldDiff({ conflict, onResolve }: { conflict: DisplayConflict; onResolve: (chosen: 'local' | 'remote') => void }) {
  const [ops, setOps] = useState<{ type: 'same' | 'removed' | 'added'; text: string }[] | null>(null);
  const isArrayField = Array.isArray(conflict.localValue) || Array.isArray(conflict.remoteValue);
  // steps/ingredients/toolIds (ARRAY_FIELDS in conflicts.local.ts) are
  // whole-array fields of ROW OBJECTS, not strings — ADR 0002 already
  // ruled out per-row diffing for them (no stable per-row identity), so
  // the line-diff below only ever applies to genuine string-array fields
  // (tags, regions, synonyms, ...). Running diffLines() on an object
  // array used to push raw row objects into DiffOp.text and render them
  // directly as JSX children — React error #31 (Objects are not valid as
  // a React child), uncaught, blanking the whole app the moment any
  // recipe had a steps/ingredients/toolIds conflict pending.
  const isDiffableStringArray = isStringArray(conflict.localValue) && isStringArray(conflict.remoteValue);

  useEffect(() => {
    if (!isDiffableStringArray) return;
    import('../lib/lineDiff').then(({ diffLines }) => {
      setOps(diffLines(conflict.localValue as string[], conflict.remoteValue as string[]));
    });
  }, [conflict, isDiffableStringArray]);

  if (isArrayField && !isDiffableStringArray) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 bg-white rounded-xl p-3 border border-zinc-200">
          <div className="text-xs text-zinc-600 font-medium">
            <span className="font-black text-zinc-800">mine:</span> {conflictValuePreview(conflict.localValue)}
            <span className="mx-2 text-zinc-300">|</span>
            <span className="font-black text-zinc-800">theirs:</span> {conflictValuePreview(conflict.remoteValue)}
          </div>
        </div>
        <p className="text-[11px] text-zinc-400">
          No per-row identity for this field, so only a count can be shown here (not a line-by-line diff). Resolving it isn't available yet — it needs the full sync engine.
        </p>
      </div>
    );
  }

  if (isDiffableStringArray) {
    return (
      <div className="space-y-2">
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="px-3 py-1.5 bg-zinc-50 border-b border-zinc-200 flex items-center gap-3 text-[10px] font-black uppercase tracking-widest">
            <span className="flex items-center gap-1 text-red-600"><span className="w-2 h-2 rounded-sm bg-red-200 inline-block" />only in mine</span>
            <span className="flex items-center gap-1 text-emerald-600"><span className="w-2 h-2 rounded-sm bg-emerald-200 inline-block" />only in theirs</span>
          </div>
          <div className="divide-y divide-zinc-100">
            {(ops ?? []).map((op, i) => (
              <div
                key={i}
                className={`px-3 py-1.5 text-xs font-medium flex gap-2 ${
                  op.type === 'removed' ? 'bg-red-50 text-red-800' : op.type === 'added' ? 'bg-emerald-50 text-emerald-800' : 'text-zinc-600'
                }`}
              >
                <span className="font-black w-3 shrink-0">{op.type === 'removed' ? '−' : op.type === 'added' ? '+' : ''}</span>
                {op.text}
              </div>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-zinc-400">
          Resolving this field isn't available yet — it needs the full sync engine, not just this preview.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-white rounded-xl p-3 border border-zinc-200">
      <div className="text-xs text-zinc-600 font-medium">
        <span className="font-black text-zinc-800">mine:</span> {conflictValuePreview(conflict.localValue)}
        <span className="mx-2 text-zinc-300">|</span>
        <span className="font-black text-zinc-800">theirs:</span> {conflictValuePreview(conflict.remoteValue)}
      </div>
      <div className="flex gap-2 shrink-0">
        <button type="button" onClick={() => onResolve('local')} className="px-2.5 py-1 bg-zinc-100 rounded-lg text-[11px] font-black text-zinc-700 hover:bg-zinc-200">Mine</button>
        <button type="button" onClick={() => onResolve('remote')} className="px-2.5 py-1 bg-zinc-900 text-white rounded-lg text-[11px] font-black hover:bg-zinc-800">Theirs</button>
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
  return (
    <div className="bg-zinc-50 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-black text-zinc-800">{entityConflicts[0].entityName}</p>
        <span className="px-2.5 py-0.5 bg-white border border-zinc-200 rounded-full text-[10px] font-black text-zinc-500 capitalize">
          {entityConflicts[0].entityType} · {entityConflicts.length} conflict{entityConflicts.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {entityConflicts.map((c) => (
          <button
            key={c.fieldName}
            type="button"
            onClick={() => onOpenField(c.fieldName)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${openField === c.fieldName ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-200 text-zinc-600'}`}
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
 *  wired to conflicts.local.ts's real data instead of mock data. Renders
 *  nothing when there are no pending conflicts — currently that's always,
 *  since nothing creates a sync_conflicts row until the Sync Engine
 *  (ticket 02/03's remainder) exists; this UI is ready ahead of it. */
function ConflictsCard() {
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
      setError(err instanceof Error ? err.message : 'Could not resolve conflict');
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
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <h2 className="text-lg font-black text-zinc-900 mb-1">Needs Your Attention</h2>
      <p className="text-sm text-zinc-400 font-medium mb-4">
        {groups.size} item{groups.size === 1 ? '' : 's'} changed differently on two devices.
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
  const navigate = useNavigate();
  const [standalone, setStandalone] = useState(false);
  const [electron, setElectron] = useState(false);
  const [syncMode, setSyncModeState] = useState<'folder' | 'git-remote'>('folder');
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [gitRemoteUrl, setGitRemoteUrl] = useState('');
  const [gitRemoteUsername, setGitRemoteUsername] = useState('');
  const [gitRemoteToken, setGitRemoteToken] = useState('');
  const [gitRemoteTokenConfigured, setGitRemoteTokenConfigured] = useState(false);
  const [gitRemoteTokenTouched, setGitRemoteTokenTouched] = useState(false);
  const [gitRemoteCorsProxy, setGitRemoteCorsProxy] = useState('');
  const [showCorsProxy, setShowCorsProxy] = useState(false);
  const [savingGitRemote, setSavingGitRemote] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<'ok' | string | null>(null);
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
  const [syncing, setSyncing] = useState(false);
  const [resyncingAll, setResyncingAll] = useState(false);
  const [resyncProgress, setResyncProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = async () => {
    const { listDeviceRecords } = await import('../lib/sync/gitSync');
    setDevices(await listDeviceRecords());
  };

  const refreshPauseReason = async () => {
    if (electron) return; // Electron has no separate mirror step to pause
    const { getSyncPauseReason } = await import('../lib/sync/androidMirror');
    setPauseReason(await getSyncPauseReason());
  };

  useEffect(() => {
    Promise.all([
      import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()),
      import('../lib/electronBridge').then(({ isElectron }) => isElectron()),
    ]).then(async ([isStandalone, isElectronApp]) => {
      setStandalone(isStandalone);
      setElectron(isElectronApp);
      if (!isStandalone) return;
      const { getLastSyncAt, getDeviceId, getDeviceName } = await import('../lib/sync/gitSync');
      const { getSyncMode, getGitRemoteConfig, getSyncInterval } = await import('../lib/sync/syncSettings');
      setLastSyncAt(await getLastSyncAt());
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
      if (syncMode === 'folder') await Promise.all([refreshDevices(), refreshPauseReason()]);
      else await refreshPauseReason();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
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
      setError(err instanceof Error ? err.message : 'Could not resync all data');
    } finally {
      setResyncingAll(false);
      setResyncProgress(null);
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
      setError(err instanceof Error ? err.message : 'Could not change folder');
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
      setError(err instanceof Error ? err.message : 'Could not save device name');
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
      const { testGitRemoteConnection } = await import('../lib/sync/gitRemoteTransport');
      const err = await testGitRemoteConnection({
        url: gitRemoteUrl.trim(),
        username: gitRemoteUsername.trim() || null,
        token: gitRemoteTokenTouched ? (gitRemoteToken.trim() || null) : null,
        corsProxy: gitRemoteCorsProxy.trim() || null,
      });
      setConnectionTestResult(err ?? 'ok');
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
      setError(err instanceof Error ? err.message : 'Could not save git remote settings');
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

  return (
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-black text-zinc-900">Folder Sync</h2>
          <p className="text-sm text-zinc-400 font-medium mt-1">
            Choose how this device exchanges changes with your others — a plain synced folder, or a real git server.
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {pauseReason && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">warning</span>
            Sync paused — {pauseReason}
          </p>
        )}

        <div>
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Sync Mode</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSelectMode('folder')}
              className={`text-left p-4 rounded-2xl border transition-colors ${syncMode === 'folder' ? 'border-primary bg-primary/5' : 'border-zinc-200 bg-zinc-50 hover:bg-zinc-100'}`}
            >
              <p className="text-sm font-black text-zinc-900">Folder</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {electron
                  ? 'A folder inside OneDrive/Drive/Syncthing.'
                  : 'A Drive/OneDrive/Syncthing SAF folder.'}
              </p>
            </button>
            <button
              type="button"
              onClick={() => handleSelectMode('git-remote')}
              className={`text-left p-4 rounded-2xl border transition-colors ${syncMode === 'git-remote' ? 'border-primary bg-primary/5' : 'border-zinc-200 bg-zinc-50 hover:bg-zinc-100'}`}
            >
              <p className="text-sm font-black text-zinc-900">Git Remote</p>
              <p className="text-xs text-zinc-500 mt-0.5">GitHub, GitLab, or a self-hosted git server.</p>
            </button>
          </div>
        </div>

        {syncMode === 'folder' ? (
          <div className="flex gap-8 flex-wrap">
            <div className="min-w-0">
              <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Sync Folder</p>
              <p className="text-sm font-bold text-zinc-900 truncate max-w-xs" title={folderPath ?? undefined}>{folderPath ?? 'None chosen yet'}</p>
            </div>
            <div className="self-end">
              <button
                type="button"
                onClick={handleChangeFolder}
                disabled={choosingFolder}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-100 text-zinc-600 rounded-xl font-black text-xs hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">folder_open</span>
                {choosingFolder ? 'Choosing…' : folderPath ? 'Change Folder' : 'Choose Folder'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 bg-zinc-50 rounded-2xl p-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Repository URL</label>
              <input
                type="text"
                value={gitRemoteUrl}
                onChange={(e) => setGitRemoteUrl(e.target.value)}
                placeholder="https://github.com/you/smartchef-sync.git"
                className="w-full bg-white rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium px-4 py-2.5 text-sm"
              />
              <p className="text-xs text-zinc-400 mt-1.5">
                An empty private repo works fine — GitHub, GitLab, or any self-hosted git-http server your other devices can also reach.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Username</label>
                <input
                  type="text"
                  value={gitRemoteUsername}
                  onChange={(e) => setGitRemoteUsername(e.target.value)}
                  placeholder="Usually optional with a token"
                  className="w-full bg-white rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium px-4 py-2.5 text-sm"
                />
              </div>
              <ProviderKeyInput
                label="Access Token"
                placeholder="Personal access token / password"
                value={gitRemoteToken}
                hasKey={gitRemoteTokenConfigured}
                touched={gitRemoteTokenTouched}
                onChange={(v, t) => { setGitRemoteToken(v); setGitRemoteTokenTouched(t); }}
              />
            </div>
            {showCorsProxy ? (
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">CORS Proxy (rarely needed)</label>
                <input
                  type="text"
                  value={gitRemoteCorsProxy}
                  onChange={(e) => setGitRemoteCorsProxy(e.target.value)}
                  placeholder="Leave blank unless you have a specific reason to set one"
                  className="w-full bg-white rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium px-4 py-2.5 text-sm"
                />
                <p className="text-xs text-zinc-400 mt-1.5">
                  This app reaches GitHub/GitLab/self-hosted servers directly through native code on both Windows and
                  Android, not the browser — so unlike most git-in-the-browser tools, no CORS proxy is needed here at all,
                  including for GitHub/GitLab. Leave this blank.
                </p>
              </div>
            ) : (
              <button type="button" onClick={() => setShowCorsProxy(true)} className="text-xs font-bold text-zinc-400 hover:text-zinc-600">
                + Advanced: CORS proxy (not needed for GitHub/GitLab — this app connects directly)
              </button>
            )}
            {connectionTestResult && (
              <p className={`text-xs font-medium flex items-start gap-2 ${connectionTestResult === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
                <span className="material-symbols-outlined text-[16px] shrink-0">{connectionTestResult === 'ok' ? 'check_circle' : 'error'}</span>
                {connectionTestResult === 'ok' ? 'Reachable — credentials accepted.' : connectionTestResult}
              </p>
            )}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testingConnection || !gitRemoteUrl.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-600 rounded-xl font-black text-xs hover:bg-zinc-100 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-base ${testingConnection ? 'animate-spin' : ''}`}>wifi_tethering</span>
                {testingConnection ? 'Testing…' : 'Test Connection'}
              </button>
              <button
                type="button"
                onClick={handleSaveGitRemote}
                disabled={savingGitRemote || !gitRemoteUrl.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl font-black text-xs hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">{savingGitRemote ? 'sync' : 'save'}</span>
                {savingGitRemote ? 'Saving…' : 'Save & Sync'}
              </button>
            </div>
          </div>
        )}

        <div>
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Automatic Sync</label>
          <div className="flex items-center gap-2 flex-wrap">
            {SYNC_INTERVAL_PRESETS.map((preset) => {
              const active = intervalValue === preset.value && intervalUnit === preset.unit;
              return (
                <button
                  key={`${preset.value}-${preset.unit}`}
                  type="button"
                  onClick={() => handleSaveInterval(preset.value, preset.unit)}
                  disabled={savingInterval}
                  className={`px-3 py-1.5 rounded-full text-xs font-black transition-colors disabled:opacity-50 ${active ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
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
                className="w-16 bg-zinc-50 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold px-2 py-1.5 text-xs text-center"
              />
              <select
                value={intervalUnit}
                onChange={(e) => {
                  const unit = e.target.value as SyncIntervalUnit;
                  setIntervalUnitState(unit);
                  handleSaveInterval(intervalValue, unit);
                }}
                disabled={savingInterval}
                className="bg-zinc-50 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold px-2 py-1.5 text-xs disabled:opacity-50"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-zinc-400 mt-1.5">How often SmartChef checks for changes automatically, besides on app resume and "Sync Now".</p>
        </div>

        <div>
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Device Name</label>
          <div className="flex gap-2 max-w-sm">
            <input
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceNameState(e.target.value)}
              onBlur={handleSaveDeviceName}
              placeholder={deviceId ?? ''}
              className="flex-1 bg-zinc-50 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium px-4 py-2.5 text-sm"
            />
            {savingName && <span className="material-symbols-outlined text-lg text-zinc-400 animate-spin self-center">sync</span>}
          </div>
        </div>

        <div className="flex gap-8 flex-wrap">
          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">This Device</p>
            <p className="text-sm font-bold text-zinc-900">{deviceId ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Last Sync</p>
            <p className="text-sm font-bold text-zinc-900">{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'Never'}</p>
          </div>
        </div>

        {syncMode === 'folder' && devices.length > 0 && (
          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Known Devices</p>
            <div className="space-y-1.5">
              {devices.map((d) => (
                <div key={d.deviceId} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 rounded-xl">
                  <span className="text-sm font-bold text-zinc-700">
                    {d.deviceName}
                    {d.deviceId === deviceId && <span className="text-zinc-400 font-medium"> (this device)</span>}
                  </span>
                  <span className="text-xs text-zinc-400">{formatRelativeTime(d.lastSyncAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {syncMode === 'git-remote' && (
          <p className="text-xs text-zinc-400">
            Known-devices tracking isn't available in Git Remote mode yet — check "History" below for recent activity instead.
          </p>
        )}

        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        {resyncingAll && resyncProgress && (
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-medium">
              Resyncing {resyncProgress.phase} — {resyncProgress.done}/{resyncProgress.total}
            </p>
            <div className="h-1.5 w-full bg-zinc-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all bg-amber-500"
                style={{ width: `${resyncProgress.total ? Math.round((resyncProgress.done / resyncProgress.total) * 100) : 100}%` }}
              />
            </div>
          </div>
        )}
        {resyncingAll && !resyncProgress && !syncing && (
          <p className="text-xs text-zinc-500 font-medium">Preparing to resync…</p>
        )}
        {syncing && progress && (
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-medium">
              {progress.phase === 'push' ? 'Uploading to the Sync Folder' : 'Downloading from the Sync Folder'} — {progress.done}/{progress.total} object{progress.total === 1 ? '' : 's'}
            </p>
            <div className="h-1.5 w-full bg-zinc-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${progress.phase === 'push' ? 'bg-primary' : 'bg-sky-500'}`}
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 100}%` }}
              />
            </div>
          </div>
        )}
        {!syncing && result && (
          <p className="text-xs text-zinc-500 font-medium">
            {result.pushedObjects > 0 && `Uploaded ${result.pushedObjects} object${result.pushedObjects === 1 ? '' : 's'}. `}
            {result.pulledObjects > 0 && `Downloaded ${result.pulledObjects} object${result.pulledObjects === 1 ? '' : 's'}. `}
            {result.pushedObjects === 0 && result.pulledObjects === 0 && 'Nothing to upload or download — already in sync. '}
            {result.applied > 0
              ? `Applied ${formatAppliedByType(result.appliedByType) || `${result.applied} change${result.applied === 1 ? '' : 's'}`} from other devices.`
              : 'Nothing new from other devices.'}
            {result.committed ? ' Your own changes were committed.' : ''}
            {result.conflicts > 0 ? ` ${result.conflicts} field${result.conflicts === 1 ? '' : 's'} need${result.conflicts === 1 ? 's' : ''} your review.` : ''}
          </p>
        )}
        {!syncing && result && result.failedEntities.length > 0 && (
          <p className="text-xs text-red-600 font-medium">
            {result.failedEntities.length} item{result.failedEntities.length === 1 ? '' : 's'} from other devices couldn't be
            saved here ({result.failedEntities.map((f) => f.entityType).join(', ')}) — try Sync Now again; if it keeps
            happening, that data may need attention on the device that created it.
          </p>
        )}

        <div className="flex gap-3 flex-wrap">
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-2xl font-black text-sm hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${syncing ? 'animate-spin' : ''}`}>sync</span>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <button
            type="button"
            onClick={handleResyncAll}
            disabled={resyncingAll || syncing}
            title="Re-serializes every recipe, ingredient, tool, tag, technique, and profile this device has and pushes them all — use after updating if something looks missing on the other end, not needed for routine syncing"
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 text-zinc-600 rounded-2xl font-black text-sm hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-lg ${resyncingAll ? 'animate-spin' : ''}`}>refresh</span>
            {resyncingAll ? 'Resyncing…' : 'Resync All'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/sync-history')}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 text-zinc-600 rounded-2xl font-black text-sm hover:bg-zinc-200 transition-all active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-lg">history</span>
            History
          </button>
        </div>
      </div>
    </div>
  );
}

function OfflineDownloadsCard() {
  const navigate = useNavigate();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    import('../lib/offlineStore').then(({ listDownloadedRecipes }) => listDownloadedRecipes()).then((r) => setCount(r.length)).catch(() => setCount(0));
  }, []);

  return (
    <button
      type="button"
      onClick={() => navigate('/downloads')}
      className="w-full flex items-center justify-between gap-4 bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8 text-left hover:border-zinc-200 transition-colors"
    >
      <div>
        <h2 className="text-lg font-black text-zinc-900">Offline Downloads</h2>
        <p className="text-sm text-zinc-400 font-medium mt-1">
          {count === null ? 'Loading…' : count === 0 ? 'No recipes downloaded for offline viewing yet.' : `${count} recipe${count === 1 ? '' : 's'} downloaded for offline viewing.`}
        </p>
      </div>
      <span className="material-symbols-outlined text-zinc-400">chevron_right</span>
    </button>
  );
}

function SyncCard() {
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
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Sync failed');
      setLastSummary(json.data.imported);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  if (!status) return null;

  return (
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-black text-zinc-900">Multi-Device Sync</h2>
          <p className="text-sm text-zinc-400 font-medium mt-1">
            {status.enabled
              ? 'Backs up and merges your library through a shared folder.'
              : 'Disabled — enable via SYNC_ENABLED in this instance\'s .env, then restart.'}
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${status.enabled ? 'bg-primary/10 text-primary' : 'bg-zinc-100 text-zinc-400'}`}>
          {status.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {status.enabled && (
        <div className="space-y-5">
          <div className="flex gap-8">
            <div>
              <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">This Device</p>
              <p className="text-sm font-bold text-zinc-900">{status.deviceName}</p>
            </div>
            <div>
              <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Last Sync</p>
              <p className="text-sm font-bold text-zinc-900">{status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : 'Never'}</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Known Devices</p>
            {!status.peers || status.peers.length === 0 ? (
              <p className="text-sm text-zinc-400">No other devices seen yet.</p>
            ) : (
              <div className="space-y-1.5">
                {status.peers.map((p) => (
                  <div key={p.deviceId} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 rounded-xl">
                    <span className="text-sm font-bold text-zinc-700">{p.deviceName}</span>
                    <span className="text-xs text-zinc-400">{formatRelativeTime(p.lastSeenAt)}</span>
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
            {syncing ? 'Syncing…' : 'Sync Now'}
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
const PROVIDER_KEY_META: Record<string, { label: string; placeholder: string }> = {
  anthropic: { label: 'Claude (Anthropic) API Key', placeholder: 'sk-ant-...' },
  gemini: { label: 'Google Gemini API Key', placeholder: 'AIza...' },
  openai: { label: 'OpenAI API Key', placeholder: 'sk-...' },
};

function ProviderKeyInput({
  label, placeholder, value, hasKey, touched, onChange,
}: {
  label: string; placeholder: string; value: string; hasKey: boolean; touched: boolean;
  onChange: (value: string, touched: boolean) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{label}</label>
      <div className="relative">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value, true)}
          placeholder={hasKey && !touched ? '•••••••• (configured — leave blank to keep)' : placeholder}
          className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4 pr-24"
        />
        {hasKey && !touched && (
          <button
            type="button"
            onClick={() => onChange('', true)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400 hover:text-red-600 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

const PROVIDER_KEY_STATE_KEYS = ['anthropic', 'gemini', 'openai'] as const;
type CloudProvider = (typeof PROVIDER_KEY_STATE_KEYS)[number];

function LlmProviderCard() {
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
      .catch(() => {})
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
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Failed to save');
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
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  const cloudProvider = provider !== 'ollama' ? (provider as CloudProvider) : null;

  return (
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900">AI Provider</h2>
        <p className="text-sm text-zinc-400 font-medium mt-1">
          Choose what powers Smart Import's recipe parsing — local Ollama (free, private, slower
          on CPU-only hardware) or a cloud provider (faster/higher quality, billed by them directly).
        </p>
      </div>

      <div className="space-y-5">
        <div>
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4 appearance-none cursor-pointer"
          >
            <option value="ollama">Local (Ollama) — default, private</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="gemini">Google (Gemini)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </div>

        {cloudProvider && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">info</span>
            Recipe text/URLs you import will be sent to {PROVIDER_LABELS[provider]}'s servers for processing.
            Local (Ollama) keeps everything on this device.
          </p>
        )}

        {/* Exactly one config field, matching whichever provider is selected above —
            an API key for a cloud provider, a base URL for local Ollama — rather than
            showing all four regardless of what's actually in use. */}
        {cloudProvider ? (
          <ProviderKeyInput
            label={PROVIDER_KEY_META[cloudProvider].label}
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
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Ollama URL</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434 (default — leave blank unless Ollama runs elsewhere)"
              className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
            />
            <p className="text-xs text-zinc-400 mt-2">
              Only needed if Ollama runs on a different host or port — e.g. another machine on your network.
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
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ManageUsersCard() {
  return (
    <Link
      to="/manage-users"
      className="flex items-center justify-between bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8 hover:border-zinc-200 transition-colors"
    >
      <div>
        <h2 className="text-lg font-black text-zinc-900">Manage Users</h2>
        <p className="text-sm text-zinc-400 font-medium mt-1">Add or review who can log into this instance.</p>
      </div>
      <span className="material-symbols-outlined text-zinc-300">chevron_right</span>
    </Link>
  );
}

function BackupCard() {
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
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Export failed');
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
      setError(err instanceof Error ? err.message : 'Export failed');
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
        throw new Error('That file is not valid JSON.');
      }
      const res = await apiFetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
        timeoutMs: 60_000,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Restore failed');
      setLastSummary(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoring(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900">Backup &amp; Restore</h2>
        <p className="text-sm text-zinc-400 font-medium mt-1">
          Download your whole library as a single file — save it wherever you like, including a
          cloud-synced folder. Restoring merges it back in (newest wins per item), it won't wipe
          anything.
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
          {exporting ? 'Exporting…' : 'Export Backup'}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={restoring}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 text-zinc-700 rounded-2xl font-black text-sm hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50"
        >
          <span className={`material-symbols-outlined text-lg ${restoring ? 'animate-spin' : ''}`}>
            {restoring ? 'sync' : 'upload_file'}
          </span>
          {restoring ? 'Restoring…' : 'Restore from Backup'}
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
    import('../lib/standalone').then(({ getStandaloneProfile }) => getStandaloneProfile()).then((profile) => {
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
      setError(err instanceof Error ? err.message : 'Could not save name');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    const { clearStandaloneProfile } = await import('../lib/standalone');
    await clearStandaloneProfile();
    window.location.href = '/';
  };

  // Distinct from Log Out: this keeps standalone mode, the local library,
  // and the Sync Folder exactly as they are — it only clears which profile
  // *this device* is currently using, bringing back the "who's cooking?"
  // picker (ProfilePicker.tsx) so someone else sharing this device (or
  // this same person switching between two of their own profiles) can
  // pick who they are without re-entering any setup.
  const handleSwitchProfile = async () => {
    const { clearActiveProfile } = await import('../lib/standalone');
    await clearActiveProfile();
    window.location.href = '/';
  };

  return (
    <form onSubmit={handleSave} className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 space-y-6">
      <div>
        <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
        />
        <p className="text-xs text-zinc-400 mt-2">
          No password in offline mode — this device's data is already private to you. Used to label recipes you create and cooks you log.
        </p>
      </div>
      <div>
        <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Avatar</label>
        {AVATAR_PRESETS.length > 0 && (
          <div className="flex flex-wrap gap-3 mb-4">
            {AVATAR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAvatarUrl(preset)}
                className={`w-12 h-12 rounded-full overflow-hidden shrink-0 transition-all ${avatarUrl === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200'}`}
              >
                <img src={preset} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <span className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">or use your own image</span>
        <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} />
      </div>
      {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      <div className="flex gap-4 pt-2">
        <button
          type="submit"
          disabled={saving || !name.trim() || !dirty}
          className="flex-1 py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-lg">{saving ? 'sync' : saved ? 'check' : 'save'}</span>
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save Changes'}
        </button>
        <button
          type="button"
          onClick={handleSwitchProfile}
          title="Switch to another profile on this device, without leaving offline mode"
          className="px-6 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all active:scale-[0.98]"
        >
          Switch Profile
        </button>
        <button
          type="button"
          onClick={handleLogout}
          title="Forget this device's offline setup entirely"
          className="px-6 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all active:scale-[0.98]"
        >
          Log Out
        </button>
      </div>
    </form>
  );
}

export default function Account() {
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
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Failed to save');
      if (account) setAccount({ ...account, name, username: username.toLowerCase(), avatarUrl: avatarUrl || undefined });
      setPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
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
      <div className="p-6 sm:p-12 max-w-2xl mx-auto">
        <div className="mb-10">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-600 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            Back
          </button>
          <h1 className="text-4xl font-black text-zinc-900 tracking-tighter">Account</h1>
        </div>

        {standalone === null ? null : standalone ? (
          <StandaloneProfileCard />
        ) : (
          <form onSubmit={handleSave} className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 space-y-6">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Username</label>
              <input
                type="text"
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Avatar</label>
              <div className="flex flex-wrap gap-3 mb-4">
                {AVATAR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAvatarUrl(preset)}
                    className={`w-12 h-12 rounded-full overflow-hidden shrink-0 transition-all ${avatarUrl === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200'}`}
                  >
                    <img src={preset} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
              <span className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">or use your own image</span>
              <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">New Password (leave blank to keep current)</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
              />
            </div>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            <div className="flex gap-4 pt-2">
              <button
                type="submit"
                disabled={saving || !name}
                className="flex-1 py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg">{saving ? 'sync' : saved ? 'check' : 'save'}</span>
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="px-6 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all active:scale-[0.98]"
              >
                Log Out
              </button>
            </div>
          </form>
        )}

        {!standalone && account?.role === 'admin' && <ManageUsersCard />}
        <LlmProviderCard />
        <BackupCard />
        <SyncCard />
        {isNative() && !standalone && <OfflineDownloadsCard />}
        {standalone && <ConflictsCard />}
        <FolderSyncCard />
      </div>
    </AppLayout>
  );
}
