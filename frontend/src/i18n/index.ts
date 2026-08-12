import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

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
  lng: localStorage.getItem("smartchef.uiLang") || "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
