import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addCustomLanguage,
  listLanguages,
  removeCustomLanguage,
  type Language,
} from '../lib/languages';

// Custom languages live in localStorage, which fires no event in the tab
// that wrote them — so a picker in the header and the editor in Settings
// would otherwise disagree until a reload. This module-level subscriber list
// is what keeps every mounted picker in step the moment one is added.
const listeners = new Set<() => void>();

function notifyLanguagesChanged(): void {
  for (const l of listeners) l();
}

/** The language list for any picker, plus add/remove.
 *
 *  Re-derives whenever the UI language changes as well, because a custom
 *  language's label comes from Intl.DisplayNames and is therefore itself
 *  translated — "pt" reads "Portuguese" with an English UI and "Portoghese"
 *  with an Italian one. */
export function useLanguages() {
  const { i18n } = useTranslation();
  const [languages, setLanguages] = useState<Language[]>(() => listLanguages(i18n.language));

  const refresh = useCallback(() => {
    setLanguages(listLanguages(i18n.language));
  }, [i18n.language]);

  useEffect(() => {
    refresh();
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);

  // Another tab (or the Electron second window) adding a language does fire
  // `storage`, so that case is covered too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'smartchef.customLanguages') refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  const add = useCallback((code: string) => {
    addCustomLanguage(code);
    notifyLanguagesChanged();
  }, []);

  const remove = useCallback((code: string) => {
    removeCustomLanguage(code);
    notifyLanguagesChanged();
  }, []);

  return { languages, add, remove };
}
