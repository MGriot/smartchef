// ════════════════════════════════════════════════════════════════════════
// SmartChef — "This device cannot upload" banner
//
// Extracted from ServerConnect.tsx, where it used to be inlined and was
// therefore the ONLY place in the app that ever said a token had been
// refused. That put the warning on the one screen that cannot act on it:
// first-run setup has no token field to correct, and by the time someone
// reaches Account -> Folder Sync — which does — the banner is long gone.
//
// Copy is keyed in remoteAccessProbe.ts beside the code that decides the
// state, so a new RemoteAccessKind cannot be added without copy for it.
// ════════════════════════════════════════════════════════════════════════

import { accessProblemCopy } from '../lib/sync/remoteAccessProbe';
import type { GitRemoteAccessProblem } from '../lib/sync/syncSettings';

interface RemoteAccessNoticeProps {
  /** null renders nothing, so callers can pass state straight through
   *  without guarding at every call site. */
  kind: GitRemoteAccessProblem | null;
  /** Where to fix it, when the surrounding screen is not itself the place.
   *  Omitted on Account, which IS the place. */
  hint?: string;
}

export function RemoteAccessNotice({ kind, hint }: RemoteAccessNoticeProps) {
  if (!kind) return null;
  const copy = accessProblemCopy(kind);

  return (
    <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-4 space-y-1">
      <p className="text-sm font-bold text-amber-900 dark:text-amber-200 flex items-start gap-2">
        <span className="material-symbols-outlined text-[18px] shrink-0">warning</span>
        {copy.title}
      </p>
      <p className="text-xs text-amber-800 dark:text-amber-300/80">{copy.body}</p>
      {hint && <p className="text-xs text-amber-800 dark:text-amber-300/80">{hint}</p>}
    </div>
  );
}
