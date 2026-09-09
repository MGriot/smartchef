import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { translateTagGroup } from '../lib/tagGroups';

export interface CatalogTag {
  id: string;
  name: string;
  translated_name?: string | null;
  group_name: string;
  color?: string | null;
}

interface TagPickerProps {
  value: string[];
  onChange: (values: string[]) => void;
  /**
   * 'name' (default): value/onChange deal in tag *names*, matching how
   * recipes.tags is stored (free TEXT[]). 'id': value/onChange deal in
   * tag ids, matching ingredients' tagIds → ingredient_tags relation.
   * 'name' mode also renders any value not found in the catalog as a
   * read-only "custom" chip (handles legacy free-text recipe tags).
   */
  by?: 'name' | 'id';
}

/**
 * Toggleable chips sourced from the managed tag catalog (GET /api/tags),
 * grouped by group_name.
 */
export default function TagPicker({ value, onChange, by = 'name' }: TagPickerProps) {
  const [catalog, setCatalog] = useState<CatalogTag[]>([]);
  const contentLang = useStore((s) => s.contentLang);
  const { t } = useTranslation();

  useEffect(() => {
    apiFetch(`/api/tags${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => setCatalog(json.data || []))
      .catch(() => setCatalog([]));
  }, [contentLang]);

  const keyOf = (t: CatalogTag) => by === 'id' ? t.id : t.name.toLowerCase();
  const isActive = (t: CatalogTag) =>
    by === 'id' ? value.includes(t.id) : value.some(v => v.toLowerCase() === t.name.toLowerCase());

  const toggle = (t: CatalogTag) => {
    if (by === 'id') {
      onChange(value.includes(t.id) ? value.filter(v => v !== t.id) : [...value, t.id]);
    } else {
      const has = value.some(v => v.toLowerCase() === t.name.toLowerCase());
      onChange(has ? value.filter(v => v.toLowerCase() !== t.name.toLowerCase()) : [...value, t.name]);
    }
  };

  const groups = catalog.reduce<Record<string, CatalogTag[]>>((acc, t) => {
    (acc[t.group_name] ||= []).push(t);
    return acc;
  }, {});

  const catalogKeys = new Set(catalog.map(t => keyOf(t)));
  const customValues = by === 'name' ? value.filter(v => !catalogKeys.has(v.toLowerCase())) : [];
  const removeCustom = (v: string) => onChange(value.filter(x => x !== v));

  return (
    <div className="space-y-3">
      {Object.entries(groups).map(([group, tags]) => (
        <div key={group}>
          <p className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">{translateTagGroup(group, t)}</p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map(t => {
              const active = isActive(t);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggle(t)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                    active
                      ? 'text-white border-transparent shadow-sm'
                      : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                  }`}
                  style={active ? { backgroundColor: t.color || '#3f3f46' } : undefined}
                >
                  {t.translated_name || t.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {customValues.length > 0 && (
        <div>
          <p className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">{t('editors.customNotInCatalog')}</p>
          <div className="flex flex-wrap gap-1.5">
            {customValues.map(v => (
              <span key={v} className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-dashed border-zinc-300 dark:border-zinc-600">
                {v}
                <button type="button" onClick={() => removeCustom(v)} className="hover:text-red-500">
                  <span className="material-symbols-outlined text-[13px] block">close</span>
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {catalog.length === 0 && customValues.length === 0 && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">{t('tagPicker.emptyCatalog')}</p>
      )}
    </div>
  );
}
