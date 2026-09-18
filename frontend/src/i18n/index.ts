import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import { readUiLang } from "../lib/uiLanguage";

// Adding another language is just another locales/<code>.json file + one
// more entry in `resources` below — no other architecture change needed.
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
];

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
    fr: { translation: fr },
    es: { translation: es },
  },
  // The device-wide bootstrap value, deliberately not an account-scoped one:
  // this runs at module init, long before App.tsx knows who is signed in.
  // store/app.store.ts's setAccount() switches to that account's own choice
  // as soon as there is one (lib/uiLanguage.ts).
  lng: readUiLang(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
