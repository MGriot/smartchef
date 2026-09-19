import i18n from '../i18n';

/** "3 min ago" / "3 minuti fa" / "il y a 3 minutes" in the app's language.
 *  Past a day it switches to the date itself, unless `days` asks for
 *  "2 days ago" instead — a download list reads better that way, a sync
 *  log with an exact date. */
export function formatRelativeTime(when: number | string | Date, opts: { days?: boolean } = {}): string {
  const ts = new Date(when).getTime();
  const lang = i18n.language;
  const mins = Math.round((ts - Date.now()) / 60000);
  if (Math.abs(mins) < 1) return i18n.t('common.justNow');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  if (opts.days) return rtf.format(Math.round(hours / 24), 'day');
  return new Date(ts).toLocaleString(lang);
}
