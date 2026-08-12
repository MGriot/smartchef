import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setServerUrl } from '../lib/api';

interface ServerConnectProps {
  onConnected: () => void;
}

export default function ServerConnect({ onConnected }: ServerConnectProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('https://');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white rounded-[40px] shadow-sm border border-zinc-100 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 font-medium">{t('login.connectSubtitle')}</p>
        </div>

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
      </div>
    </div>
  );
}
