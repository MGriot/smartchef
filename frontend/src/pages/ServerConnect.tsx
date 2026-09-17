import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setServerUrl } from '../lib/api';
import { initStandaloneProfile, activateStandaloneProfile, type StandaloneProfile } from '../lib/standalone';
import { AVATAR_PRESETS, DEFAULT_AVATAR } from '../lib/avatarPresets';
import ImageUrlInput from '../components/ImageUrlInput';
import { ResolvedImage } from '../components/CoverImage';
import { RemoteAccessNotice } from '../components/RemoteAccessNotice';
import { checkTokenShape } from '../lib/sync/tokenShape';
import type { RemoteAccessResult } from '../lib/sync/remoteAccessProbe';

/** Turns a probe phase into something worth reading. Bytes are shown
 *  rather than a bare percentage because on a slow link the numbers moving
 *  at all is the reassurance; a percentage that sits at 0 is not. */
function probeStatusLine(phase: import('../lib/sync/firstRunProbe').ProbePhase | null): string {
  if (!phase) return 'Checking this library for existing profiles…';
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  switch (phase.kind) {
    case 'connecting':
      return 'Connecting…';
    case 'downloading':
      return phase.total > 0
        ? `Downloading… ${mb(phase.loaded)} of ${mb(phase.total)} MB`
        : `Downloading… ${mb(phase.loaded)} MB`;
    // Named rather than folded into "downloading": on a phone this is
    // usually the longest part, and calling it a download while nothing
    // downloads is how the previous version read as a hang.
    case 'preparing':
      return 'Unpacking the library…';
    case 'reading':
      return 'Reading the profiles…';
  }
}

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

  // Git Remote is the other Sync Folder transport (see syncSettings.ts) —
  // chosen inline here so it doesn't require finishing onboarding with
  // "Skip for now" first, just to immediately go set it up again from
  // Account → Folder Sync.
  const [gitRemoteConfigured, setGitRemoteConfigured] = useState<string | null>(null);
  const [showGitForm, setShowGitForm] = useState(false);
  const [gitRemoteUrl, setGitRemoteUrl] = useState('');
  const [gitRemoteUsername, setGitRemoteUsername] = useState('');
  const [gitRemoteToken, setGitRemoteToken] = useState('');
  const [gitRemoteCorsProxy, setGitRemoteCorsProxy] = useState('');
  const [showCorsProxy, setShowCorsProxy] = useState(false);
  const tokenShapeProblem = checkTokenShape(gitRemoteUrl, gitRemoteToken);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<RemoteAccessResult | null>(null);
  const [savingGitRemote, setSavingGitRemote] = useState(false);

  // A folder someone else's device already wrote profiles into — offered
  // as "pick who you are" instead of forcing a brand-new (likely
  // redundant) profile onto a household library that already has people.
  const [checkingFolder, setCheckingFolder] = useState(false);
  const [folderProfiles, setFolderProfiles] = useState<StandaloneProfile[] | null>(null);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(null);
  const [forceCreateNew, setForceCreateNew] = useState(false);
  // Why the profile probe came back empty, when it came back empty because
  // something failed rather than because the library really has nobody in
  // it yet. Surfaced rather than swallowed — see checkForExistingProfiles().
  const [probeFailure, setProbeFailure] = useState<string | null>(null);
  // What the probe is doing, so this screen can say so. A bare spinner is
  // indistinguishable from a wedged app, which is how the slow case got
  // reported — the fix for "is it stuck?" is being able to see that it
  // isn't, and where it stopped when it is.
  const [probePhase, setProbePhase] = useState<import('../lib/sync/firstRunProbe').ProbePhase | null>(null);
  // The host refused the token but the library was readable without it —
  // reported rather than silently worked around, because reading a public
  // repository needs no credentials while every upload from this device
  // will fail until it is fixed. That exact gap once hid a week of failed
  // pushes on a desktop.
  const [tokenRejected, setTokenRejected] = useState(false);

  const checkForExistingProfiles = async () => {
    setCheckingFolder(true);
    setProbeFailure(null);
    setProbePhase(null);
    setTokenRejected(false);
    try {
      const { initLocalSchema } = await import('../db/local');
      await initLocalSchema();
      // Answering "who is using this device?" needs six small JSON files,
      // not the whole library. Against a git remote, probe for exactly
      // those — a tip-only clone, no merge, no working tree — and let the
      // recipes, ingredients and images arrive on the ordinary background
      // sync once the user is already in. See lib/sync/firstRunProbe.ts,
      // including why this must not be done by merging profiles first.
      //
      // Folder mode has no equivalent fast path (no network to save, and
      // gitObjectTransport.ts copies objects rather than fetching a pack),
      // so it still does the full sync here and says so by reporting
      // `supported: false`.
      let syncError: string | null = null;
      const { probeFirstRunProfiles, importProbedProfiles } = await import('../lib/sync/firstRunProbe');
      const probe = await probeFirstRunProfiles(setProbePhase).catch((err: unknown) => {
        syncError = err instanceof Error ? err.message : String(err);
        return null;
      });

      if (probe?.supported) {
        setTokenRejected(probe.tokenRejected === true);
        await importProbedProfiles(probe.profiles);
      } else if (probe) {
        const { syncNow } = await import('../lib/sync/gitSync');
        // Still best-effort — an unreachable or slow folder must not block
        // onboarding — but no longer *silently* so (see below).
        await syncNow().catch((err: unknown) => {
          syncError = err instanceof Error ? err.message : String(err);
        });
      }

      const { listStandaloneProfiles } = await import('../lib/standalone');
      const profiles = await listStandaloneProfiles();
      setFolderProfiles(profiles);
      // Only worth raising when it actually changes what the user is about
      // to do: profiles that did arrive are proof enough that the remote
      // was read, whatever else went wrong later in the cycle.
      if (syncError && profiles.length === 0) setProbeFailure(syncError);
    } catch (err) {
      setFolderProfiles([]);
      setProbeFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingFolder(false);
      setProbePhase(null);
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
    setProbeFailure(null);
    setSyncFolderName(null);
    setFolderProfiles(null);
    setForceCreateNew(false);
    const { clearPersistedSyncFolder } = await import('../lib/syncFolderPicker');
    await clearPersistedSyncFolder().catch(() => {});
  };

  const handleTestGitConnection = async () => {
    setTestingConnection(true);
    setConnectionTestResult(null);
    try {
      const { probeGitRemoteAccess } = await import('../lib/sync/remoteAccessProbe');
      // Unlike Account's copy of this handler, the token here is always
      // whatever is in the field — this form has no "leave blank to keep"
      // state to fall back through.
      setConnectionTestResult(
        await probeGitRemoteAccess({
          url: gitRemoteUrl.trim(),
          username: gitRemoteUsername.trim() || null,
          token: gitRemoteToken.trim() || null,
          corsProxy: gitRemoteCorsProxy.trim() || null,
        })
      );
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveGitRemote = async () => {
    setSavingGitRemote(true);
    setError(null);
    try {
      const { setSyncMode, setGitRemoteConfig } = await import('../lib/sync/syncSettings');
      await setSyncMode('git-remote');
      await setGitRemoteConfig({
        url: gitRemoteUrl.trim(),
        username: gitRemoteUsername.trim() || null,
        token: gitRemoteToken.trim() || null,
        corsProxy: gitRemoteCorsProxy.trim() || null,
      });
      setGitRemoteConfigured(gitRemoteUrl.trim());
      setShowGitForm(false);
      await checkForExistingProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save git remote settings');
    } finally {
      setSavingGitRemote(false);
    }
  };

  // Same "the picker already persisted the choice" reasoning as
  // handleRemoveSyncFolder — falls back to 'folder' mode (the default)
  // rather than leaving sync mode pointed at a now-cleared git remote.
  const handleRemoveGitRemote = async () => {
    setProbeFailure(null);
    setTokenRejected(false);
    setGitRemoteConfigured(null);
    setConnectionTestResult(null);
    setFolderProfiles(null);
    setForceCreateNew(false);
    const { setSyncMode, clearGitRemoteConfig } = await import('../lib/sync/syncSettings');
    await clearGitRemoteConfig();
    await setSyncMode('folder');
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
      // Last line of defence against re-onboarding a device that is in fact
      // already set up. checkForExistingProfiles() above only runs when the
      // user picks a Sync Folder during onboarding, so anyone who just hit
      // "Use offline on this device" and typed a name went straight to
      // initStandaloneProfile() — which unconditionally CREATES a profile.
      //
      // A library that already has profiles is, by definition, not a first
      // run. Reaching this screen with one is a bug somewhere upstream (a
      // second app instance whose localStorage came up empty was the one
      // found in the wild — see the single-instance lock in
      // electron/src/index.ts), and the right response to that is to offer
      // the profiles that exist, not to quietly add a duplicate of the
      // person already in there.
      const { initLocalSchema } = await import('../db/local');
      await initLocalSchema();
      const { listStandaloneProfiles } = await import('../lib/standalone');
      const existing = await listStandaloneProfiles();
      if (existing.length > 0 && !forceCreateNew) {
        setFolderProfiles(existing);
        return;
      }

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

  // Once profiles are known to exist — either in a Sync Folder the user
  // just chose, or already in this device's local library (see
  // handleStartOffline) — show "pick who you are" instead of the name form,
  // unless the user explicitly asked to create a brand-new one anyway
  // (forceCreateNew).
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
                Optional. Point this at a folder your other devices can also reach (e.g. a Syncthing-managed folder), or
                connect directly to a git server (GitHub, GitLab, self-hosted). Skip this for now — you can always set it up
                later from Account → Folder Sync.
              </p>
              {syncFolderName ? (
                <div className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-xl px-3 py-2.5 border border-zinc-200 dark:border-zinc-700">
                  <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 truncate">{syncFolderName}</span>
                  <button type="button" onClick={handleRemoveSyncFolder} className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 hover:text-red-600">Remove</button>
                </div>
              ) : gitRemoteConfigured ? (
                <div className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-xl px-3 py-2.5 border border-zinc-200 dark:border-zinc-700">
                  <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 truncate" title={gitRemoteConfigured}>{gitRemoteConfigured}</span>
                  <button type="button" onClick={handleRemoveGitRemote} className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 hover:text-red-600">Remove</button>
                </div>
              ) : showGitForm ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Repository URL</label>
                    <input
                      type="text"
                      autoFocus
                      value={gitRemoteUrl}
                      onChange={(e) => setGitRemoteUrl(e.target.value)}
                      placeholder="https://github.com/you/smartchef-sync.git"
                      className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                    />
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">An empty private repo works fine.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Username</label>
                      <input
                        type="text"
                        value={gitRemoteUsername}
                        onChange={(e) => setGitRemoteUsername(e.target.value)}
                        placeholder="Usually optional with a token"
                        className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Access Token</label>
                      <input
                        type="password"
                        value={gitRemoteToken}
                        onChange={(e) => setGitRemoteToken(e.target.value)}
                        placeholder="Personal access token / password"
                        className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                      />
                      {/* Advisory only — Continue stays enabled. See
                          tokenShape.ts for why a hard block is worse. */}
                      {tokenShapeProblem && (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
                          <span className="material-symbols-outlined text-[16px] shrink-0">warning</span>
                          {tokenShapeProblem.message}
                        </p>
                      )}
                    </div>
                  </div>
                  {showCorsProxy ? (
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">CORS Proxy (rarely needed)</label>
                      <input
                        type="text"
                        value={gitRemoteCorsProxy}
                        onChange={(e) => setGitRemoteCorsProxy(e.target.value)}
                        placeholder="Leave blank unless you have a specific reason to set one"
                        className="w-full bg-white dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium px-4 py-2.5 text-sm"
                      />
                    </div>
                  ) : (
                    <button type="button" onClick={() => setShowCorsProxy(true)} className="text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400">
                      + Advanced: CORS proxy (not needed for GitHub/GitLab)
                    </button>
                  )}
                  {connectionTestResult && (
                    <p
                      className={`text-xs font-medium flex items-start gap-2 ${
                        connectionTestResult.kind === 'writable'
                          ? 'text-emerald-700'
                          : connectionTestResult.kind === 'not-found' || connectionTestResult.kind === 'unreachable'
                            ? 'text-red-600'
                            : 'text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px] shrink-0">
                        {connectionTestResult.kind === 'writable' ? 'check_circle' : 'warning'}
                      </span>
                      {connectionTestResult.message}
                    </p>
                  )}
                  {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setShowGitForm(false)}
                      className="px-4 py-2.5 rounded-xl text-xs font-black bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={handleTestGitConnection}
                      disabled={testingConnection || !gitRemoteUrl.trim()}
                      className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 rounded-xl font-black text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      <span className={`material-symbols-outlined text-base ${testingConnection ? 'animate-spin' : ''}`}>wifi_tethering</span>
                      {testingConnection ? 'Testing…' : 'Test Connection'}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveGitRemote}
                      disabled={savingGitRemote || !gitRemoteUrl.trim()}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl font-black text-xs hover:bg-zinc-800 transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-base">{savingGitRemote ? 'sync' : 'save'}</span>
                      {savingGitRemote ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
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
                    onClick={() => setShowGitForm(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 rounded-xl text-xs font-black hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="material-symbols-outlined text-[16px]">dns</span>
                    Git Server
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
              <div className="py-4 space-y-2">
                <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium text-center">{probeStatusLine(probePhase)}</p>
                {probePhase?.kind === 'downloading' && probePhase.total > 0 && (
                  <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-primary transition-[width] duration-300"
                      style={{ width: `${Math.min(100, Math.round((probePhase.loaded / probePhase.total) * 100))}%` }}
                    />
                  </div>
                )}
                {/* This step is deliberately small now — see
                    firstRunProbe.ts. It used to run a whole sync here,
                    which on a phone was indistinguishable from a hang. */}
                <p className="text-xs text-zinc-400 dark:text-zinc-600 text-center">Only the profiles are fetched now — your recipes download in the background once you're in.</p>
              </div>
            )}

            {!checkingFolder && tokenRejected && (
              <RemoteAccessNotice kind="token-rejected" hint="You can change it later in Account → Folder Sync." />
            )}

            {!checkingFolder && probeFailure && (
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-4 space-y-2">
                <p className="text-sm font-bold text-amber-900 dark:text-amber-200">Couldn't read this library</p>
                <p className="text-xs text-amber-800 dark:text-amber-300/80">{probeFailure}</p>
                <p className="text-xs text-amber-800 dark:text-amber-300/80">
                  If other devices already share it, go back and check the address and token rather than creating a profile here — a
                  new profile made now would be a second copy of someone the library may already have.
                </p>
              </div>
            )}

            {!checkingFolder && showExistingProfilesPicker && (
              <div className="space-y-5">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">This library already has profiles — pick who you are, or create a new one.</p>
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
                      {/* Shown because a household library can have several
                          people with similar names, and which one you are
                          decides whether the admin-only screens appear at
                          all — see applyAdminFallback() in firstRunProbe.ts
                          for how this is resolved when a profile predates
                          the role field entirely. */}
                      {p.role === 'admin' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-black uppercase tracking-wider">
                          <span className="material-symbols-outlined text-[12px]">shield_person</span>
                          Admin
                        </span>
                      )}
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
