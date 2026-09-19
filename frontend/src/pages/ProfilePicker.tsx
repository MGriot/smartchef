import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVATAR_PRESETS, DEFAULT_AVATAR } from '../lib/avatarPresets';
import ImageUrlInput from '../components/ImageUrlInput';
import { ResolvedImage } from '../components/CoverImage';
import type { StandaloneProfile } from '../lib/standalone';

interface ProfilePickerProps {
  onPicked: () => void;
  /** Native first-run only — see Login.tsx's prop of the same name. */
  onChangeStorage?: () => void;
}

/** "Who's cooking?" — shown whenever this device is standalone-enabled but
 *  has no active profile: right after "Switch Profile," or on a device
 *  that just joined an existing Sync Folder and pulled in profiles other
 *  devices already created. Picking an existing profile or creating a new
 *  one both just call back into App.tsx's checkNativeReady() (onPicked)
 *  to re-derive auth state, same as ServerConnect.tsx's onConnected. */
export default function ProfilePicker({ onPicked, onChangeStorage }: ProfilePickerProps) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<StandaloneProfile[] | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AVATAR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    import('../lib/standalone').then(({ listStandaloneProfiles }) => listStandaloneProfiles()).then(setProfiles);
  }, []);

  const handlePick = async (id: string) => {
    setActivating(id);
    setError(null);
    try {
      const { activateStandaloneProfile } = await import('../lib/standalone');
      await activateStandaloneProfile(id);
      onPicked();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connect.errorSwitchProfile'));
      setActivating(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { createAndActivateProfile } = await import('../lib/standalone');
      await createAndActivateProfile(newName, newAvatar || null);
      onPicked();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profiles.createFailed'));
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center p-6 font-outfit">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-[40px] shadow-sm border border-zinc-100 dark:border-zinc-800 p-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black text-primary tracking-tight mb-2">SmartChef</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{creating ? t('profiles.createTitle') : t('profiles.whoIsCooking')}</p>
        </div>

        {error && <p className="text-sm text-red-600 font-medium mb-4">{error}</p>}

        {!creating && (
          <>
            {profiles === null ? (
              <p className="text-center text-sm text-zinc-400 dark:text-zinc-500 py-6">{t('profiles.loading')}</p>
            ) : profiles.length === 0 ? (
              <p className="text-center text-sm text-zinc-400 dark:text-zinc-500 py-6">{t('profiles.empty')}</p>
            ) : (
              <div className="space-y-2 mb-4">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handlePick(p.id)}
                    disabled={activating !== null}
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
                    {p.role === 'admin' && (
                      <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-black uppercase tracking-wider">{t('connect.admin')}</span>
                    )}
                    {activating === p.id && <span className="material-symbols-outlined text-primary animate-spin ml-auto text-lg">sync</span>}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full flex items-center justify-center gap-2 p-4 bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-2xl text-zinc-500 dark:text-zinc-400 font-bold text-sm transition-colors"
            >
              <span className="material-symbols-outlined text-lg">add</span>
              {t('connect.newProfile')}
            </button>
          </>
        )}

        {creating && (
          <form onSubmit={handleCreate} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('connect.yourName')}</label>
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('connect.yourNamePlaceholder')}
                className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('connect.avatar')}</label>
              {AVATAR_PRESETS.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {AVATAR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setNewAvatar(preset)}
                      className={`w-12 h-12 rounded-full overflow-hidden shrink-0 transition-all ${newAvatar === preset ? 'ring-4 ring-primary' : 'ring-2 ring-transparent hover:ring-zinc-200 dark:hover:ring-zinc-700'}`}
                    >
                      <img src={preset} alt="" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
              <ImageUrlInput value={newAvatar} onChange={setNewAvatar} />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setCreating(false); setError(null); }}
                className="flex-1 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all"
              >
                {t('common.back')}
              </button>
              <button
                type="submit"
                disabled={saving || !newName.trim()}
                className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? t('users.creating') : t('profiles.startCooking')}
              </button>
            </div>
          </form>
        )}

        {/* First run on this device only — after that, where the library
            lives is an admin decision in Settings, not something the
            "who's cooking?" screen re-asks. */}
        {onChangeStorage && !creating && (
          <button
            type="button"
            onClick={onChangeStorage}
            className="mt-6 w-full pt-5 border-t border-zinc-100 dark:border-zinc-800 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-primary transition-colors"
          >
            {t('profiles.changeStorage')}
          </button>
        )}
      </div>
    </div>
  );
}
