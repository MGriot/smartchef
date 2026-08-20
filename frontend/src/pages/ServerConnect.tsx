import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setServerUrl } from '../lib/api';
import { initStandaloneProfile } from '../lib/standalone';

interface ServerConnectProps {
  onConnected: () => void;
}

export default function ServerConnect({ onConnected }: ServerConnectProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'choose' | 'server' | 'standalone'>('choose');
  const [url, setUrl] = useState('https://');
  const [name, setName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // wayfinder ticket 07 (standalone-storage-sync map, Variant A — combined
  // single screen): the sync-folder offer lives inline in this same form,
  // not as a side effect of initStandaloneProfile() — symmetric on both
  // platforms, unlike the old Electron-only silent-dialog behavior.
  const [syncFolderName, setSyncFolderName] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderSkipped, setFolderSkipped] = useState(false);

  const handleChooseSyncFolder = async () => {
    setChoosingFolder(true);
    setError(null);
    try {
      const { isElectron } = await import('../lib/electronBridge');
      if (isElectron()) {
        const { chooseElectronSyncFolder } = await import('../lib/gitfs');
        const chosen = await chooseElectronSyncFolder();
        if (chosen) setSyncFolderName(chosen);
      } else {
        const { pickTree } = await import('../lib/safMirrorBridge');
        const { setMirrorTree } = await import('../lib/sync/androidMirror');
        const handle = await pickTree();
        if (handle) {
          await setMirrorTree(handle.uri, handle.displayName);
          setSyncFolderName(handle.displayName);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose a sync folder');
    } finally {
      setChoosingFolder(false);
    }
  };

  const handleStartOffline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      await initStandaloneProfile(name);
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
      className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-600 text-sm font-bold mb-6 transition-colors"
    >
      <span className="material-symbols-outlined text-[18px]">arrow_back</span>
      Back
    </button>
  );

  return (
    <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white rounded-[40px] shadow-sm border border-zinc-100 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 font-medium">{t('login.connectSubtitle')}</p>
        </div>

        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setMode('server')}
              className="w-full flex items-center gap-4 p-5 bg-zinc-50 hover:bg-zinc-100 rounded-2xl text-left transition-colors"
            >
              <span className="material-symbols-outlined text-2xl text-primary">dns</span>
              <span>
                <span className="block font-bold text-zinc-900 text-sm">Connect to a server</span>
                <span className="block text-xs text-zinc-400 mt-0.5">Share a household library across devices via Tailscale/LAN</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('standalone')}
              className="w-full flex items-center gap-4 p-5 bg-zinc-50 hover:bg-zinc-100 rounded-2xl text-left transition-colors"
            >
              <span className="material-symbols-outlined text-2xl text-primary">phone_iphone</span>
              <span>
                <span className="block font-bold text-zinc-900 text-sm">Use offline on this device</span>
                <span className="block text-xs text-zinc-400 mt-0.5">No server, no account — everything stays on this device</span>
              </span>
            </button>
          </div>
        )}

        {mode === 'server' && (
          <>
            <BackButton />
            <form onSubmit={handleConnect} className="space-y-5">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.serverAddress')}</label>
                <input
                  type="url"
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://smartchef-pc.your-tailnet.ts.net"
                  className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                />
                <p className="text-xs text-zinc-400 mt-2">
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
            <form onSubmit={handleStartOffline} className="space-y-5">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Your name</label>
                <input
                  type="text"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Matteo"
                  className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                />
                <p className="text-xs text-zinc-400 mt-2">
                  Used to label recipes you create and cooks you log — no password, this device's data is already private to you.
                </p>
              </div>

              <div className="bg-zinc-50 rounded-2xl p-5">
                <p className="text-sm font-bold text-zinc-900">Sync across your devices</p>
                <p className="text-xs text-zinc-400 mt-1 mb-3">
                  Optional. Point this at a folder your other devices can also reach (e.g. a Syncthing-managed folder). You can always set this up later from Account.
                </p>
                {syncFolderName ? (
                  <div className="flex items-center justify-between bg-white rounded-xl px-3 py-2.5 border border-zinc-200">
                    <span className="text-xs font-bold text-zinc-700 truncate">{syncFolderName}</span>
                    <button type="button" onClick={() => setSyncFolderName(null)} className="text-[11px] font-black text-zinc-400 hover:text-red-600">Remove</button>
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
                      className={`px-4 py-2.5 rounded-xl text-xs font-black transition-colors ${folderSkipped ? 'bg-zinc-200 text-zinc-500' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100'}`}
                    >
                      {folderSkipped ? 'Skipped ✓' : 'Skip for now'}
                    </button>
                  </div>
                )}
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
          </>
        )}
      </div>
    </div>
  );
}
