import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setServerUrl } from '../lib/api';
import { initStandaloneProfile, activateStandaloneProfile, type StandaloneProfile } from '../lib/standalone';
import { AVATAR_PRESETS, DEFAULT_AVATAR } from '../lib/avatarPresets';
import ImageUrlInput from '../components/ImageUrlInput';
import { ResolvedImage } from '../components/CoverImage';

interface ServerConnectProps {
  onConnected: () => void;
}

export default function ServerConnect({ onConnected }: ServerConnectProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'choose' | 'server' | 'standalone'>('choose');
  const [url, setUrl] = useState('https://');
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(DEFAULT_AVATAR);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // wayfinder ticket 07 (standalone-storage-sync map, Variant A — combined
  // single screen): the sync-folder offer lives inline in this same form,
  // not as a side effect of initStandaloneProfile() — symmetric on both
  // platforms, unlike the old Electron-only silent-dialog behavior.
  const [syncFolderName, setSyncFolderName] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderSkipped, setFolderSkipped] = useState(false);

  // A folder someone else's device already wrote profiles into — offered
  // as "pick who you are" instead of forcing a brand-new (likely
  // redundant) profile onto a household library that already has people.
  const [checkingFolder, setCheckingFolder] = useState(false);
  const [folderProfiles, setFolderProfiles] = useState<StandaloneProfile[] | null>(null);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(null);
  const [forceCreateNew, setForceCreateNew] = useState(false);

  const checkForExistingProfiles = async () => {
    setCheckingFolder(true);
    try {
      const { initLocalSchema } = await import('../db/local');
      await initLocalSchema();
      const { syncNow } = await import('../lib/sync/gitSync');
      // Best-effort — an unreachable/slow folder shouldn't block onboarding,
      // it just means we fall back to "create a new profile" below.
      await syncNow().catch(() => {});
      const { listStandaloneProfiles } = await import('../lib/standalone');
      const profiles = await listStandaloneProfiles();
      setFolderProfiles(profiles);
    } catch {
      setFolderProfiles([]);
    } finally {
      setCheckingFolder(false);
    }
  };

  const handleChooseSyncFolder = async () => {
    setChoosingFolder(true);
    setError(null);
    try {
      const { pickAndPersistSyncFolder } = await import('../lib/syncFolderPicker');
      const picked = await pickAndPersistSyncFolder();
      if (picked) {
        setSyncFolderName(picked.displayName);
        await checkForExistingProfiles();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose a sync folder');
    } finally {
      setChoosingFolder(false);
    }
  };

  // The picker above already persisted the choice (both platforms' pickers
  // do that as a side effect) — undoing it in the UI alone isn't enough,
  // or submitting would wire up sync against a folder the user thought
  // they'd backed out of.
  const handleRemoveSyncFolder = async () => {
    setSyncFolderName(null);
    setFolderProfiles(null);
    setForceCreateNew(false);
    const { clearPersistedSyncFolder } = await import('../lib/syncFolderPicker');
    await clearPersistedSyncFolder().catch(() => {});
  };

  const handlePickExistingProfile = async (id: string) => {
    setActivatingProfileId(id);
    setError(null);
    try {
      await activateStandaloneProfile(id);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch profile');
      setActivatingProfileId(null);
    }
  };

  const handleStartOffline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      await initStandaloneProfile(name, avatarUrl || null);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start offline mode');
    } finally {
      setConnecting(false);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    const trimmed = url.trim().replace(/\/+$/, '');
    try {
      const res = await fetch(`${trimmed}/health`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(t('login.serverRespondedWith', { status: res.status }));
      const json = await res.json();
      if (json.status !== 'ok' && json.status !== 'degraded') throw new Error(t('login.unexpectedResponse'));
      await setServerUrl(trimmed);
      onConnected();
    } catch (err) {
      setError(
        err instanceof Error && (err.name === 'TimeoutError' || err instanceof TypeError)
          ? t('login.serverUnreachable')
          : err instanceof Error ? err.message : t('login.couldNotConnect')
      );
    } finally {
      setConnecting(false);
    }
  };

  const BackButton = () => (
    <button
      type="button"
      onClick={() => { setMode('choose'); setError(null); }}
      className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-sm font-bold mb-6 transition-colors"
    >
      <span className="material-symbols-outlined text-[18px]">arrow_back</span>
      Back
    </button>
  );

  // Once a folder that already has profiles is chosen, show "pick who you
  // are" instead of the name form — unless the user explicitly asked to
  // create a brand-new one anyway (forceCreateNew).
  const showExistingProfilesPicker = folderProfiles !== null && folderProfiles.length > 0 && !forceCreateNew;

  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-[40px] shadow-sm border border-zinc-100 dark:border-zinc-800 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('login.connectSubtitle')}</p>
        </div>

        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setMode('server')}
              className="w-full flex items-center gap-4 p-5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-2xl text-left transition-colors"
            >
              <span className="material-symbols-outlined text-2xl text-primary">dns</span>
              <span>
                <span className="block font-bold text-zinc-900 dark:text-zinc-100 text-sm">Connect to a server</span>
                <span className="block text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">Share a household library across devices via Tailscale/LAN</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('standalone')}
              className="w-full flex items-center gap-4 p-5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-2xl text-left transition-colors"
            >
              <span className="material-symbols-outlined text-2xl text-primary">phone_iphone</span>
              <span>
                <span className="block font-bold text-zinc-900 dark:text-zinc-100 text-sm">Use offline on this device</span>
                <span className="block text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">No server, no account — everything stays on this device</span>
              </span>
            </button>
          </div>
        )}

        {mode === 'server' && (
          <>
            <BackButton />
            <form onSubmit={handleConnect} className="space-y-5">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('login.serverAddress')}</label>
                <input
                  type="url"
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://smartchef-pc.your-tailnet.ts.net"
                  className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
                />
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
                  {t('login.serverAddressHint')}
                </p>
              </div>
              {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
              <button
                type="submit"
                disabled={connecting || url.trim().length < 10}
                className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {connecting ? t('login.connecting') : t('login.connect')}
              </button>
            </form>
          </>
        )}

        {mode === 'standalone' && (
          <>
            <BackButton />

            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-5 mb-5">
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Sync across your devices</p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 mb-3">
                Optional. Point this at a folder your other devices can also reach (e.g. a Syncthing-managed folder). Prefer a
                real git server (GitHub, GitLab, self-hosted) instead? Skip this for now — that's set up from Account → Folder
                Sync once you're in. You can always change either later.
              </p>
              {syncFolderName ? (
                <div className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-xl px-3 py-2.5 border border-zinc-200 dark:border-zinc-700">
                  <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 truncate">{syncFolderName}</span>
                  <button type="button" onClick={handleRemoveSyncFolder} className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 hover:text-red-600">Remove</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleChooseSyncFolder}
                    disabled={choosingFolder}
                    className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-xs font-black hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">folder_open</span>
                    {choosingFolder ? 'Choosing…' : 'Choose Folder'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFolderSkipped(true)}
                    className={`px-4 py-2.5 rounded-xl text-xs font-black transition-colors ${folderSkipped ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400' : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                  >
                    {folderSkipped ? 'Skipped ✓' : 'Skip for now'}
                  </button>
                </div>
              )}
            </div>

            {checkingFolder && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium text-center py-4">Checking this folder for existing profiles…</p>
            )}

            {!checkingFolder && showExistingProfilesPicker && (
              <div className="space-y-5">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">This folder already has profiles — pick who you are, or create a new one.</p>
                <div className="space-y-2">
                  {folderProfiles!.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handlePickExistingProfile(p.id)}
                      disabled={activatingProfileId !== null}
                      className="w-full flex items-center gap-4 p-4 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-2xl text-left transition-colors disabled:opacity-50"
                    >
                      <span className="w-12 h-12 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-700 shrink-0 flex items-center justify-center">
                        {p.avatarUrl ? (
                          <ResolvedImage src={p.avatarUrl} className="w-full h-full object-cover" />
                        ) : (
                          <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500">person</span>
                        )}
                      </span>
                      <span className="font-bold text-zinc-900 dark:text-zinc-100">{p.name}</span>
                      {activatingProfileId === p.id && <span className="material-symbols-outlined text-primary animate-spin ml-auto text-lg">sync</span>}
                    </button>
                  ))}
                </div>
                {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
                <button
                  type="button"
                  onClick={() => setForceCreateNew(true)}
                  className="w-full flex items-center justify-center gap-2 p-4 bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-2xl text-zinc-500 dark:text-zinc-400 font-bold text-sm transition-colors"
                >
                  <span className="material-symbols-outlined text-lg">add</span>
                  New Profile
                </button>
              </div>
            )}

            {!checkingFolder && !showExistingProfilesPicker && (
              <form onSubmit={handleStartOffline} className="space-y-5">
                {forceCreateNew && (
                  <button
                    type="button"
                    onClick={() => setForceCreateNew(false)}
                    className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-xs font-bold -mt-2 mb-1 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                    Back to existing profiles
                  </button>
                )}
                <div>
                  <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Your name</label>
                  <input
                    type="text"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Matteo"
                    className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
                    Used to label recipes you create and cooks you log — no password, this device's data is already private to you.
                  </p>
                </div>

                <div>
                  <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Avatar</label>
                  {AVATAR_PRESETS.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
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
                  <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} />
                </div>

                {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
                <button
                  type="submit"
                  disabled={connecting || !name.trim()}
                  className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
                >
                  {connecting ? 'Starting…' : 'Start using SmartChef offline'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
