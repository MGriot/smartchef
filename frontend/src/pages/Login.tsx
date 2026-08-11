import React, { useState } from 'react';
import ImageUrlInput from '../components/ImageUrlInput';
import { useStore } from '../store/app.store';
import { apiFetch, isNative, cacheAccountOffline } from '../lib/api';

const DEFAULT_AVATAR = 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix';

interface LoginProps {
  hasAccount: boolean;
  onAuthenticated: (account: { name: string; avatarUrl?: string }) => void;
}

export default function Login({ hasAccount, onAuthenticated }: LoginProps) {
  const setAccount = useStore((s) => s.setAccount);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
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
        body: JSON.stringify({ name, password, avatarUrl: avatarUrl || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Setup failed');
      const account = { name: json.data.name, avatarUrl: json.data.avatarUrl || undefined };
      setAccount(account);
      if (isNative()) cacheAccountOffline(account);
      onAuthenticated(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
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
        body: JSON.stringify({ password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Incorrect password');
      const account = { name: json.data.name, avatarUrl: json.data.avatarUrl || undefined };
      setAccount(account);
      if (isNative()) cacheAccountOffline(account);
      onAuthenticated(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect password');
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
            {hasAccount ? 'Enter your password to continue' : 'Set up this SmartChef instance'}
          </p>
        </div>

        {hasAccount ? (
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Password</label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !password}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetup} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Your Name</label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder="Chef"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
                placeholder="At least 4 characters"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Avatar (optional)</label>
              <ImageUrlInput value={avatarUrl} onChange={setAvatarUrl} placeholder={DEFAULT_AVATAR} />
            </div>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !name || password.length < 4}
              className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? 'Setting up…' : 'Set Up SmartChef'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
