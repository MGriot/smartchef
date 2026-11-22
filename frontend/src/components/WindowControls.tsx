import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ════════════════════════════════════════════════════════════════════════
// The desktop window's minimise / maximise / close, drawn by the app.
//
// The window has no native frame (electron/src/setup.ts), and the system's
// own caption buttons — square, Windows-grey, a different size from every
// other control in the header — read as a piece of another program glued
// onto ours. These are the header's own round icon buttons instead; close
// turns red on hover as everywhere on the platform. Nothing renders in a
// browser, on Android, or on macOS (which keeps its own buttons).
// ════════════════════════════════════════════════════════════════════════

type Controls = NonNullable<NonNullable<Window['smartchefElectron']>['windowControls']>;

function desktopControls(): Controls | null {
  const bridge = typeof window !== 'undefined' ? window.smartchefElectron : undefined;
  if (!bridge?.windowControls || bridge.platform === 'darwin') return null;
  return bridge.windowControls;
}

/** True where the app draws its own window buttons (and has no native
 *  title bar to drag by). */
export function hasWindowControls(): boolean {
  return desktopControls() !== null;
}

const BUTTON =
  'app-no-drag w-9 h-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-colors active:scale-95';

export default function WindowControls({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const controls = desktopControls();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    controls.isMaximized().then(setMaximized).catch(() => {});
    return controls.onMaximizedChange(setMaximized);
  }, [controls]);

  if (!controls) return null;

  return (
    <div className={`app-no-drag flex items-center gap-0.5 shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => void controls.minimise()}
        aria-label={t('window.minimise')}
        title={t('window.minimise')}
        className={`${BUTTON} hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100`}
      >
        <span className="material-symbols-outlined text-[18px]">remove</span>
      </button>
      <button
        type="button"
        onClick={() => void controls.toggleMaximise()}
        aria-label={maximized ? t('window.restore') : t('window.maximise')}
        title={maximized ? t('window.restore') : t('window.maximise')}
        className={`${BUTTON} hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100`}
      >
        <span className="material-symbols-outlined text-[16px]">{maximized ? 'filter_none' : 'crop_square'}</span>
      </button>
      <button
        type="button"
        onClick={() => void controls.close()}
        aria-label={t('window.close')}
        title={t('window.close')}
        className={`${BUTTON} hover:bg-red-500 hover:text-white dark:hover:bg-red-500 dark:hover:text-white`}
      >
        <span className="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>
  );
}
