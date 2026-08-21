import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import ImageUrlInput from '../components/ImageUrlInput';
import { useStore } from '../store/app.store';
import { apiFetch, isNative } from '../lib/api';

// Adaptive to whatever's in the folder — adding/removing an SVG here
// changes the preset grid with no code change needed.
const avatarModules = import.meta.glob('../assets/avatars/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const AVATAR_PRESETS = Object.keys(avatarModules)
  .sort()
  .map((path) => avatarModules[path]);

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

function ConflictFieldDiff({ conflict, onResolve }: { conflict: DisplayConflict; onResolve: (chosen: 'local' | 'remote') => void }) {
  const [ops, setOps] = useState<{ type: 'same' | 'removed' | 'added'; text: string }[] | null>(null);
  const isArrayField = Array.isArray(conflict.localValue) || Array.isArray(conflict.remoteValue);

  useEffect(() => {
    if (!isArrayField) return;
    import('../lib/lineDiff').then(({ diffLines }) => {
      setOps(diffLines(conflict.localValue as string[], conflict.remoteValue as string[]));
    });
  }, [conflict, isArrayField]);

  if (isArrayField) {
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

function FolderSyncCard() {
  const navigate = useNavigate();
  const [standalone, setStandalone] = useState(false);
  const [electron, setElectron] = useState(false);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceName, setDeviceNameState] = useState('');
  const [savedDeviceName, setSavedDeviceName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [result, setResult] = useState<{ applied: number; committed: boolean } | null>(null);
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
      setLastSyncAt(await getLastSyncAt());
      setDeviceId(await getDeviceId());
      const name = await getDeviceName();
      setDeviceNameState(name);
      setSavedDeviceName(name);
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const { syncNow } = await import('../lib/sync/gitSync');
      const r = await syncNow();
      setResult({ applied: r.applied, committed: r.committed });
      setLastSyncAt(r.lastSyncAt);
      await Promise.all([refreshDevices(), refreshPauseReason()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
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
  const resyncAllLocalData = async () => {
    const [{ resyncAllRecipes }, { resyncAllIngredients, resyncAllTools }] = await Promise.all([
      import('../services/recipes.local'),
      import('../services/ingredients.local'),
    ]);
    await resyncAllIngredients();
    await resyncAllTools();
    await resyncAllRecipes();
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

  if (!standalone) return null;

  return (
    <div className="bg-white rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 mt-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-black text-zinc-900">Folder Sync</h2>
          <p className="text-sm text-zinc-400 font-medium mt-1">
            {electron
              ? "Point this at a folder your other devices can also reach - e.g. one already inside your OneDrive/Drive desktop folder, or a Syncthing-managed folder."
              : "Pick a Drive/OneDrive (or any SAF-registered) folder your other devices can also reach."}
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {pauseReason && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">warning</span>
            Sync paused — folder access lost ({pauseReason}). Use "Change Folder" below to reconnect.
          </p>
        )}

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
          <div className="min-w-0">
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Sync Folder</p>
            <p className="text-sm font-bold text-zinc-900 truncate max-w-xs" title={folderPath ?? undefined}>{folderPath ?? 'None chosen yet'}</p>
          </div>
        </div>

        {devices.length > 0 && (
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

        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        {result && (
          <p className="text-xs text-zinc-500 font-medium">
            {result.applied > 0 ? `Pulled in ${result.applied} change${result.applied === 1 ? '' : 's'}.` : 'Nothing new from other devices.'}
            {result.committed ? ' Your own changes were committed.' : ''}
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
            onClick={handleChangeFolder}
            disabled={choosingFolder}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-zinc-100 text-zinc-600 rounded-2xl font-black text-sm hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-lg">folder_open</span>
            {choosingFolder ? 'Choosing…' : 'Change Folder'}
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
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
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

function LlmProviderCard() {
  const [provider, setProvider] = useState('ollama');
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicTouched, setAnthropicTouched] = useState(false);
  const [geminiTouched, setGeminiTouched] = useState(false);
  const [openaiTouched, setOpenaiTouched] = useState(false);
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
          setHasAnthropicKey(json.data.hasAnthropicKey);
          setHasGeminiKey(json.data.hasGeminiKey);
          setHasOpenaiKey(json.data.hasOpenaiKey);
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
      if (anthropicTouched) body.anthropicApiKey = anthropicKey;
      if (geminiTouched) body.geminiApiKey = geminiKey;
      if (openaiTouched) body.openaiApiKey = openaiKey;
      const res = await apiFetch('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Failed to save');
      if (anthropicTouched) { setHasAnthropicKey(!!anthropicKey); setAnthropicKey(''); setAnthropicTouched(false); }
      if (geminiTouched) { setHasGeminiKey(!!geminiKey); setGeminiKey(''); setGeminiTouched(false); }
      if (openaiTouched) { setHasOpenaiKey(!!openaiKey); setOpenaiKey(''); setOpenaiTouched(false); }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

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

        {provider !== 'ollama' && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] shrink-0">info</span>
            Recipe text/URLs you import will be sent to {PROVIDER_LABELS[provider]}'s servers for processing.
            Local (Ollama) keeps everything on this device.
          </p>
        )}

        <ProviderKeyInput
          label="Anthropic API Key"
          placeholder="sk-ant-..."
          value={anthropicKey}
          hasKey={hasAnthropicKey}
          touched={anthropicTouched}
          onChange={(v, t) => { setAnthropicKey(v); setAnthropicTouched(t); }}
        />
        <ProviderKeyInput
          label="Google Gemini API Key"
          placeholder="AIza..."
          value={geminiKey}
          hasKey={hasGeminiKey}
          touched={geminiTouched}
          onChange={(v, t) => { setGeminiKey(v); setGeminiTouched(t); }}
        />
        <ProviderKeyInput
          label="OpenAI API Key"
          placeholder="sk-..."
          value={openaiKey}
          hasKey={hasOpenaiKey}
          touched={openaiTouched}
          onChange={(v, t) => { setOpenaiKey(v); setOpenaiTouched(t); }}
        />

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
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    import('../lib/standalone').then(({ getStandaloneProfile }) => getStandaloneProfile()).then((profile) => {
      setName(profile?.name ?? '');
      setSavedName(profile?.name ?? '');
    });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === savedName) return;
    setSaving(true);
    setError(null);
    try {
      const { setStandaloneName } = await import('../lib/standalone');
      await setStandaloneName(trimmed);
      setSavedName(trimmed);
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
      {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      <div className="flex gap-4 pt-2">
        <button
          type="submit"
          disabled={saving || !name.trim() || name.trim() === savedName}
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
