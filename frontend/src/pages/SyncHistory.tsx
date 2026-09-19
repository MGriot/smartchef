import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import AppLayout from '../components/AppLayout';
import { formatRelativeTime } from '../lib/relativeTime';

interface SyncCommit {
  oid: string;
  message: string;
  authorName: string;
  timestamp: number;
  changedFiles: string[];
}

interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'electron';
  lastSyncAt: string;
}

const formatWhen = (ts: number) => formatRelativeTime(ts);

function describeChange(path: string, t: TFunction): string {
  const m = path.match(/^(recipes|ingredients)\/([^/]+)\.json$/);
  if (!m) return path;
  return t(m[1] === 'recipes' ? 'syncHistory.recipe' : 'syncHistory.ingredient', { id: m[2].slice(0, 8) });
}

const PLATFORM_ICON: Record<DeviceRecord['platform'], string> = {
  android: 'phone_android',
  electron: 'computer',
};

export default function SyncHistory() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [commits, setCommits] = useState<SyncCommit[] | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    import('../lib/sync/gitSync').then(({ getSyncHistory, listDeviceRecords }) => {
      getSyncHistory(100).then(setCommits).catch((err) => setError(err instanceof Error ? err.message : t('syncHistory.loadFailed')));
      listDeviceRecords().then(setDevices).catch(() => {}); // best-effort — commit history above is the primary content
    });
  }, []);

  return (
    <AppLayout>
      <div className="p-6 sm:p-12 max-w-3xl mx-auto">
        <div className="mb-10">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('common.back')}
          </button>
          <h1 className="text-4xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter">{t('syncHistory.heading')}</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-2">
            {t('syncHistory.subtitle')}
          </p>
        </div>

        {devices.length > 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 mb-8">
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100 mb-4">{t('syncHistory.devices')}</h2>
            <div className="space-y-1.5">
              {devices.map((d) => (
                <div key={d.deviceId} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 rounded-xl">
                  <span className="flex items-center gap-2 text-sm font-bold text-zinc-700 dark:text-zinc-300">
                    <span className="material-symbols-outlined text-[18px] text-zinc-400 dark:text-zinc-500">{PLATFORM_ICON[d.platform]}</span>
                    {d.deviceName}
                  </span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{formatWhen(new Date(d.lastSyncAt).getTime())}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center text-sm text-red-600 font-medium">
            {error}
          </div>
        )}

        {!error && commits === null && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
          </div>
        )}

        {!error && commits !== null && commits.length === 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('syncHistory.empty')}</p>
          </div>
        )}

        {!error && commits !== null && commits.length > 0 && (
          <div className="space-y-3">
            {commits.map((c) => (
              <div key={c.oid} className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === c.oid ? null : c.oid)}
                  className="w-full flex items-center justify-between gap-4 p-5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{c.message}</p>
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-0.5">{c.authorName} · {formatWhen(c.timestamp)}</p>
                  </div>
                  <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500 shrink-0">
                    {expanded === c.oid ? 'expand_less' : 'expand_more'}
                  </span>
                </button>
                {expanded === c.oid && (
                  <div className="px-5 pb-5 space-y-1.5">
                    {c.changedFiles.length === 0 && (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('syncHistory.noFiles')}</p>
                    )}
                    {c.changedFiles.map((f) => (
                      <div key={f} className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {describeChange(f, t)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
