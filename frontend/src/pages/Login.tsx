import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ImageUrlInput from '../components/ImageUrlInput';
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

interface LoginProps {
  hasAccount: boolean;
  onAuthenticated: (account: Account) => void;
}

export default function Login({ hasAccount, onAuthenticated }: LoginProps) {
  const { t } = useTranslation();
  const setAccount = useStore((s) => s.setAccount);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(DEFAULT_AVATAR);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, password, avatarUrl: avatarUrl || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('login.setupFailed'));
      const account: Account = { id: json.data.id, username: json.data.username, name: json.data.name, role: json.data.role, avatarUrl: json.data.avatarUrl || undefined };
      setAccount(account);
      if (isNative()) cacheAccountOffline(account);
      onAuthenticated(account);
    } catch (err) {
      setError(friendlyAuthError(err, t('login.setupFailed'), t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('login.incorrectPassword'));
      const account: Account = { id: json.data.id, username: json.data.username, name: json.data.name, role: json.data.role, avatarUrl: json.data.avatarUrl || undefined };
      setAccount(account);
      if (isNative()) cacheAccountOffline(account);
      onAuthenticated(account);
    } catch (err) {
      setError(friendlyAuthError(err, t('login.incorrectPassword'), t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white rounded-[40px] shadow-sm border border-zinc-100 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 font-medium">
            {hasAccount ? t('login.enterPasswordToContinue') : t('login.setUpInstance')}
          </p>
        </div>

        {hasAccount ? (
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.username')}</label>
              <input
                type="text"
                autoFocus
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder={t('login.usernamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.password')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('login.signingIn') : t('login.signIn')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetup} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.yourName')}</label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder={t('login.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.username')}</label>
              <input
                type="text"
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder={t('login.usernamePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.password')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder={t('login.atLeastFourChars')}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{t('login.avatarOptional')}</label>
              {AVATAR_PRESETS.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
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
              <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} placeholder={DEFAULT_AVATAR} />
            </div>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !name || !username || password.length < 4}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('login.settingUp') : t('login.setUpSmartChef')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
