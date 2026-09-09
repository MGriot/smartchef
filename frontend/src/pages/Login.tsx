import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ImageUrlInput from '../components/ImageUrlInput';
import { ResolvedImage } from '../components/CoverImage';
import { useStore, Account } from '../store/app.store';
import { apiFetch, isNative, cacheAccountOffline } from '../lib/api';
import { AVATAR_PRESETS, DEFAULT_AVATAR } from '../lib/avatarPresets';

// A raw `TypeError: Failed to fetch` (CORS rejection, DNS failure, refused
// connection) reads as gibberish shown verbatim — the most common real
// cause here is CORS_ORIGIN left at its wildcard default, which browsers
// silently reject for the credentialed requests this app always sends.
function friendlyAuthError(err: unknown, fallback: string, t: (key: string) => string): string {
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return t('login.networkError');
  }
  return err instanceof Error ? err.message : fallback;
}

interface PublicProfile {
  id: string;
  username: string;
  name: string;
  avatarUrl?: string | null;
}

interface LoginProps {
  hasAccount: boolean;
  onAuthenticated: (account: Account) => void;
  /** Native first-run only: drop back to the "server or offline?" chooser.
   *  Omitted once this device is past first run — after that, changing where
   *  the library lives is an admin decision made in Settings (Account.tsx's
   *  StorageModeCard), not something the login screen re-asks every time
   *  somebody signs out. */
  onChangeStorage?: () => void;
}

/** Server-mode sign-in.
 *
 *  Three screens in one, by `view`:
 *    - `pick`    — "who's cooking?", the faces of every account on this
 *                  server (GET /auth/profiles, public), plus sign-in-by-
 *                  username and self-signup as escapes. This is where a
 *                  sign-out lands.
 *    - `password`— one account chosen, just the password left.
 *    - `register`— self-signup (POST /auth/register, always role "user").
 *  Plus first-run `setup`, which mints the instance's admin and is the only
 *  view shown while the server has no account at all.
 */
export default function Login({ hasAccount, onAuthenticated, onChangeStorage }: LoginProps) {
  const { t } = useTranslation();
  const setAccount = useStore((s) => s.setAccount);

  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [view, setView] = useState<'pick' | 'password' | 'register'>('pick');
  const [picked, setPicked] = useState<PublicProfile | null>(null);

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(DEFAULT_AVATAR);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Public list — empty (not an error) on an instance that has turned
  // self-service auth off, in which case the picker falls back to plain
  // username + password.
  useEffect(() => {
    if (!hasAccount) return;
    apiFetch('/api/auth/profiles')
      .then((res) => res.json())
      .then((json) => setProfiles(Array.isArray(json.data) ? json.data : []))
      .catch(() => setProfiles([]));
  }, [hasAccount]);

  const finish = (data: any) => {
    const account: Account = {
      id: data.id, username: data.username, name: data.name,
      role: data.role, avatarUrl: data.avatarUrl || undefined,
    };
    setAccount(account);
    if (isNative()) cacheAccountOffline(account);
    onAuthenticated(account);
  };

  const post = async (path: string, body: unknown, fallbackMsg: string) => {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : fallbackMsg);
    return json.data;
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      finish(await post('/api/auth/setup', { name, username, password, avatarUrl: avatarUrl || undefined }, t('login.setupFailed')));
    } catch (err) {
      setError(friendlyAuthError(err, t('login.setupFailed'), t));
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      finish(await post('/api/auth/login', { username, password }, t('login.incorrectPassword')));
    } catch (err) {
      setError(friendlyAuthError(err, t('login.incorrectPassword'), t));
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      finish(await post('/api/auth/register', { name, username, password, avatarUrl: avatarUrl || undefined }, t('login.signUpFailed')));
    } catch (err) {
      setError(friendlyAuthError(err, t('login.signUpFailed'), t));
      setSubmitting(false);
    }
  };

  const choose = (p: PublicProfile) => {
    setPicked(p);
    setUsername(p.username);
    setPassword('');
    setError(null);
    setView('password');
  };

  const backToPick = () => {
    setPicked(null);
    setUsername('');
    setPassword('');
    setError(null);
    setView('pick');
  };

  const subtitle = !hasAccount
    ? t('login.setUpInstance')
    : view === 'register'
      ? t('login.createYourAccount')
      : view === 'password'
        ? t('login.enterPasswordToContinue')
        : t('login.whosCooking');

  const avatarField = (
    <div>
      <label className="sc-label mb-2">{t('login.avatarOptional')}</label>
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
      <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} placeholder={DEFAULT_AVATAR} />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-[40px] shadow-sm border border-zinc-100 dark:border-zinc-800 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{subtitle}</p>
        </div>

        {error && <p className="text-sm text-red-600 font-medium mb-4">{error}</p>}

        {/* ── First run: mint the admin ─────────────────────────────── */}
        {!hasAccount && (
          <form onSubmit={handleSetup} className="space-y-5">
            <div>
              <label className="sc-label mb-2">{t('login.yourName')}</label>
              <input
                type="text" autoFocus value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('login.namePlaceholder')}
                className="sc-field"
              />
            </div>
            <div>
              <label className="sc-label mb-2">{t('login.username')}</label>
              <input
                type="text" autoCapitalize="none" value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder={t('login.usernamePlaceholder')}
                className="sc-field"
              />
            </div>
            <div>
              <label className="sc-label mb-2">{t('login.password')}</label>
              <input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.atLeastFourChars')}
                className="sc-field"
              />
            </div>
            {avatarField}
            <button
              type="submit"
              disabled={submitting || !name || !username || password.length < 4}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('login.settingUp') : t('login.setUpSmartChef')}
            </button>
          </form>
        )}

        {/* ── Who's cooking? ────────────────────────────────────────── */}
        {hasAccount && view === 'pick' && (
          <>
            {profiles === null ? (
              <p className="text-center text-sm text-zinc-400 dark:text-zinc-500 py-6">{t('common.loading')}</p>
            ) : profiles.length > 0 ? (
              <div className="space-y-2 mb-4">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => choose(p)}
                    className="w-full flex items-center gap-4 p-4 bg-zinc-50 dark:bg-zinc-800/60 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-2xl text-left transition-colors"
                  >
                    <span className="w-12 h-12 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-700 shrink-0 flex items-center justify-center">
                      {p.avatarUrl ? (
                        <ResolvedImage src={p.avatarUrl} className="w-full h-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500">person</span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-bold text-zinc-900 dark:text-zinc-100 truncate">{p.name}</span>
                      <span className="block text-xs text-zinc-400 dark:text-zinc-500">@{p.username}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { setError(null); setName(''); setUsername(''); setPassword(''); setView('register'); }}
                className="w-full flex items-center justify-center gap-2 p-4 border border-dashed border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 rounded-2xl text-zinc-500 dark:text-zinc-400 font-bold text-sm transition-colors"
              >
                <span className="material-symbols-outlined text-lg">person_add</span>
                {t('login.createNewUser')}
              </button>
              <button
                type="button"
                onClick={() => { setPicked(null); setUsername(''); setError(null); setView('password'); }}
                className="w-full py-2 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              >
                {t('login.signInWithUsername')}
              </button>
            </div>
          </>
        )}

        {/* ── Password (a face was picked, or "use my username") ────── */}
        {hasAccount && view === 'password' && (
          <form onSubmit={handleLogin} className="space-y-5">
            {picked && (
              <div className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-2xl">
                <span className="w-10 h-10 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-700 shrink-0 flex items-center justify-center">
                  {picked.avatarUrl ? (
                    <ResolvedImage src={picked.avatarUrl} className="w-full h-full object-cover" />
                  ) : (
                    <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500">person</span>
                  )}
                </span>
                <span className="font-bold text-zinc-900 dark:text-zinc-100 truncate">{picked.name}</span>
              </div>
            )}
            {!picked && (
              <div>
                <label className="sc-label mb-2">{t('login.username')}</label>
                <input
                  type="text" autoFocus autoCapitalize="none" value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('login.usernamePlaceholder')}
                  className="sc-field"
                />
              </div>
            )}
            <div>
              <label className="sc-label mb-2">{t('login.password')}</label>
              <input
                type="password" autoFocus={!!picked} value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="sc-field"
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('login.signingIn') : t('login.signIn')}
            </button>
            <button
              type="button"
              onClick={backToPick}
              className="w-full py-2 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
            >
              {t('login.backToProfiles')}
            </button>
          </form>
        )}

        {/* ── Self sign-up ─────────────────────────────────────────── */}
        {hasAccount && view === 'register' && (
          <form onSubmit={handleRegister} className="space-y-5">
            <div>
              <label className="sc-label mb-2">{t('login.yourName')}</label>
              <input
                type="text" autoFocus value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('login.namePlaceholder')}
                className="sc-field"
              />
            </div>
            <div>
              <label className="sc-label mb-2">{t('login.username')}</label>
              <input
                type="text" autoCapitalize="none" value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder={t('login.usernamePlaceholder')}
                className="sc-field"
              />
            </div>
            <div>
              <label className="sc-label mb-2">{t('login.password')}</label>
              <input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.atLeastFourChars')}
                className="sc-field"
              />
            </div>
            {avatarField}
            <button
              type="submit"
              disabled={submitting || !name || !username || password.length < 4}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('login.signingUp') : t('login.createAccount')}
            </button>
            <button
              type="button"
              onClick={backToPick}
              className="w-full py-2 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
            >
              {t('login.backToProfiles')}
            </button>
          </form>
        )}

        {/* First run on this device only — where the library actually lives
            is otherwise an admin decision in Settings, not a question this
            screen re-asks whenever somebody signs out. */}
        {onChangeStorage && (
          <button
            type="button"
            onClick={onChangeStorage}
            className="mt-6 w-full pt-5 border-t border-zinc-100 dark:border-zinc-800 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-primary transition-colors"
          >
            {t('login.changeStorage')}
          </button>
        )}
      </div>
    </div>
  );
}
