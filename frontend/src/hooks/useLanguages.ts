import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addCustomLanguage,
  canHideLanguage,
  hasUiBundle,
  hideLanguage,
  listHiddenLanguages,
  listLanguages,
  removeCustomLanguage,
  unhideLanguage,
  type Language,
} from '../lib/languages';
import { persistUiLang } from '../lib/uiLanguage';
import { SETTINGS_CACHE_KEY } from '../lib/settingsCache';
import { useStore } from '../store/app.store';

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
  const [hidden, setHidden] = useState<Language[]>(() => listHiddenLanguages(i18n.language));

  const refresh = useCallback(() => {
    setLanguages(listLanguages(i18n.language));
    setHidden(listHiddenLanguages(i18n.language));
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
    // Both lists live inside the settings cache blob now, under one key.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_CACHE_KEY) refresh();
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

  /** Takes a language out of every picker without deleting anything it
   *  was used for — see lib/languages.ts. Works on the bundled four,
   *  which `remove` deliberately cannot touch. */
  const hide = useCallback((code: string) => {
    hideLanguage(code);
    notifyLanguagesChanged();
  }, []);

  const unhide = useCallback((code: string) => {
    unhideLanguage(code);
    notifyLanguagesChanged();
  }, []);

  return { languages, hidden, add, remove, hide, unhide, canHide: canHideLanguage };
}

/** The header/recipe-page language picker's own behaviour, in one place.
 *
 *  It used to be copy-pasted into AppLayout.tsx and RecipeDetail.tsx, and the
 *  two copies had already drifted: only one of them checked hasUiBundle(), so
 *  picking a user-added content language from a recipe page threw the whole
 *  interface back to English with no way to tell what had happened.
 *
 *  A user-added language has no translation bundle, so switching the
 *  interface to it would fall back to English — losing the UI language the
 *  user had, to no benefit. For those, only the content language moves:
 *  recipes are read and written in the new language while the interface stays
 *  where it was. The bundled four behave as before, moving both at once,
 *  which stays the friendly default; Account → Languages is where the
 *  interface can be set on its own. */
export function useUiAndContentLanguage() {
  const { i18n } = useTranslation();
  const setContentLang = useStore((s) => s.setContentLang);
  const accountId = useStore((s) => s.account?.id);

  return useCallback(
    (code: string) => {
      if (hasUiBundle(code)) {
        void i18n.changeLanguage(code);
        // Per account, not per device — see lib/uiLanguage.ts.
        persistUiLang(code, accountId);
      }
      setContentLang(code);
    },
    [i18n, setContentLang, accountId],
  );
}
