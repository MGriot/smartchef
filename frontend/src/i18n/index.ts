import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

// Only English ships today. Adding a language later is just another
// locales/<code>.json file + one more entry in `resources` below —
// no other architecture change needed.
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
];

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: localStorage.getItem("smartchef.uiLang") || "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
