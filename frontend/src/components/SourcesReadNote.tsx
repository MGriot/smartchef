import { useTranslation } from 'react-i18next';

export interface SourceReadEntry { url: string; ok: boolean; title?: string; error?: string }

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

/** Which of a recipe's reference pages the AI read, and which it could not
 *  open. Shown with every AI answer that used them, so "the AI checked the
 *  source" is something the user can see rather than take on trust. */
export default function SourcesReadNote({ sources }: { sources: SourceReadEntry[] | undefined }) {
  const { t } = useTranslation();
  if (!sources || sources.length === 0) return null;
  const read = sources.filter((s) => s.ok).length;
  return (
    <section className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 px-4 py-3">
      <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
        {t('recipeDetail.aiSources.title', { read, total: sources.length })}
      </h3>
      <ul className="mt-2 space-y-1">
        {sources.map((s) => (
          <li key={s.url} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300 min-w-0">
            <span className={`material-symbols-outlined text-[16px] shrink-0 ${s.ok ? 'text-primary' : 'text-amber-600 dark:text-amber-400'}`}>
              {s.ok ? 'check_circle' : 'error'}
            </span>
            <span className="min-w-0 break-words">
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-bold hover:underline">{hostOf(s.url)}</a>
              {s.title ? ` · ${s.title}` : ''}
              {!s.ok && <span className="text-amber-700 dark:text-amber-400"> · {t('recipeDetail.aiSources.unreadable')}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
