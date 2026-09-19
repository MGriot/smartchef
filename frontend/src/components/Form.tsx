import React from 'react';
import { useTranslation } from 'react-i18next';
import RenderFaIcon from './RenderFaIcon';

/** A titled band of related fields inside a dialog body.
 *
 *  The library dialogs were a flat run of a dozen labelled inputs — name,
 *  translations, category, icon, notes, nutrition, photos, seasonality,
 *  synonyms, parent, tags — every one of them looking exactly as important as
 *  every other, so finding a field meant reading all of them. Grouping them
 *  under headings is the whole point: identity, then classification, then the
 *  optional extras. */
export function FormSection({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  /** Small control aligned with the heading, e.g. "+ Add lang". */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-4 ${className}`}>
      <div className="flex items-end justify-between gap-4 border-b border-zinc-100 dark:border-zinc-800 pb-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-black uppercase tracking-[0.15em] text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          {description && <p className="sc-hint mt-1">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Label + optional hint wrapped around one control. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      {label && (
        <label htmlFor={htmlFor} className="sc-label mb-1.5">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="sc-hint mt-1.5">{hint}</p>}
    </div>
  );
}

/** Side-by-side fields that stack on a narrow dialog rather than squeezing. */
export function FieldRow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${className}`}>{children}</div>;
}

/** Icon grid, shared by the ingredient / tool / technique / tag dialogs.
 *
 *  Each of them had its own copy, and every copy painted unselected icons
 *  `bg-white dark:bg-zinc-900` on a `dark:bg-zinc-900` panel — invisible tiles
 *  in dark mode. The grid is also capped and scrollable now: the tag dialog
 *  lists 24 icons, which as a static 6-wide block pushed the rest of the form
 *  a screen and a half down. */
export function IconPicker({
  icons,
  value,
  onChange,
  columns = 8,
}: {
  icons: readonly string[];
  value: string;
  onChange: (icon: string) => void;
  columns?: number;
}) {
  return (
    <div
      className="sc-panel grid max-h-52 gap-2 overflow-y-auto p-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {icons.map(ic => {
        const selected = value === ic;
        return (
          <button
            key={ic}
            type="button"
            title={ic}
            aria-pressed={selected}
            onClick={() => onChange(ic)}
            className={`flex aspect-square w-full items-center justify-center rounded-xl border transition-all ${
              selected
                ? 'border-transparent bg-primary text-white shadow-md shadow-primary/30'
                : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:border-primary/40 hover:text-primary'
            }`}
          >
            <RenderFaIcon name={ic} className="text-[19px]" />
          </button>
        );
      })}
    </div>
  );
}

export interface LangEntry {
  lang: string;
  [key: string]: string;
}

/** The lang-code + translated-name row list.
 *
 *  Verbatim duplicated across the ingredient, tool, technique, unit and tag
 *  dialogs, each with its own add/remove/change handlers on the page. The
 *  ingredient rows store the text under `text` and everything else under
 *  `name`, hence `textKey`. */
export function TranslationRows<T extends LangEntry>({
  value,
  onChange,
  textKey = 'name' as keyof T & string,
  emptyLabel,
  langPlaceholder = 'IT',
  textPlaceholder,
}: {
  value: T[];
  onChange: (next: T[]) => void;
  textKey?: keyof T & string;
  emptyLabel: string;
  langPlaceholder?: string;
  textPlaceholder: string;
}) {
  const { t } = useTranslation();
  const update = (idx: number, field: string, raw: string) => {
    const next = value.map((row, i) =>
      i === idx ? { ...row, [field]: field === 'lang' ? raw.toLowerCase() : raw } : row,
    );
    onChange(next as T[]);
  };

  if (value.length === 0) {
    return <p className="sc-hint py-2 text-center">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-2.5">
      {value.map((row, i) => (
        <div key={i}>
          <div className="flex items-center gap-2">
          <input
            type="text"
            maxLength={3}
            placeholder={langPlaceholder}
            value={row.lang}
            onChange={e => update(i, 'lang', e.target.value)}
            className="sc-field-inset w-[4.5rem] shrink-0 text-center uppercase"
          />
          <input
            type="text"
            placeholder={textPlaceholder}
            value={(row[textKey] as string) || ''}
            onChange={e => update(i, textKey, e.target.value)}
            className="sc-field-inset min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={t('common.removeTranslation')}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-400 dark:text-zinc-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
          </div>
          {/* Catalog names are English already: an "en" row only repeats them. */}
          {row.lang.trim().toLowerCase() === 'en' && (
            <p className="sc-hint mt-1 pl-1 text-amber-600 dark:text-amber-400">{t('common.englishIsBase')}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/** The "+ Add lang" control that pairs with <TranslationRows>. */
export function AddLangButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-primary hover:underline"
    >
      <span className="material-symbols-outlined text-[14px]">add</span>
      {label}
    </button>
  );
}
