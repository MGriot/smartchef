import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import ImageUrlInput from '../components/ImageUrlInput';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

interface SyncPeer {
  deviceId: string;
  deviceName: string;
  lastSeenAt: string;
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
  ingredients: number; recipes: number; collections: number;
  conflicts: string[];
}

const SYNC_SUMMARY_LABELS: Record<keyof Omit<SyncSummary, 'conflicts'>, string> = {
  categories: 'categories', tools: 'tools', techniques: 'techniques', tags: 'tags',
  ingredients: 'ingredients', recipes: 'recipes', collections: 'collections',
};

function SyncSummaryPanel({ summary }: { summary: SyncSummary }) {
  const changes = (Object.keys(SYNC_SUMMARY_LABELS) as Array<keyof typeof SYNC_SUMMARY_LABELS>)
    .map((key) => ({ key, count: summary[key], label: SYNC_SUMMARY_LABELS[key] }))
    .filter((c) => c.count > 0);

  return (
    <div className="mt-4 p-4 bg-zinc-50 rounded-2xl space-y-2">
      {changes.length === 0 && summary.conflicts.length === 0 ? (
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
          {summary.conflicts.length > 0 && (
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
    <div className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 mt-8">
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
      const res = await apiFetch('/api/backup/export');
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
    <div className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 mt-8">
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

export default function Account() {
  const navigate = useNavigate();
  const account = useStore((s) => s.account);
  const setAccount = useStore((s) => s.setAccount);

  const [name, setName] = useState(account?.name ?? '');
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
      if (password) body.password = password;
      const res = await apiFetch('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Failed to save');
      setAccount({ name, avatarUrl: avatarUrl || undefined });
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
      <div className="p-12 max-w-2xl mx-auto">
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

        <form onSubmit={handleSave} className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 space-y-6">
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
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Avatar</label>
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

        <BackupCard />
        <SyncCard />
      </div>
    </AppLayout>
  );
}
