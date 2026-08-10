import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { SUPPORTED_LANGUAGES } from '../i18n';

type LibrarySection = 'ingredients' | 'tools' | 'units' | 'techniques';

interface AppLayoutProps {
  children: React.ReactNode;
  /** When set, renders the "Management" library sidebar with this section highlighted. */
  librarySection?: LibrarySection;
  /** Extra content appended below the static library nav (e.g. the dynamic categories list). */
  sidebarExtra?: React.ReactNode;
  /** Extra content rendered in the header's right-hand action area, before the language switcher. */
  headerActions?: React.ReactNode;
}

const NAV_LINKS: { to: string; labelKey: string }[] = [
  { to: '/', labelKey: 'nav.gallery' },
  { to: '/planner', labelKey: 'nav.planner' },
  { to: '/shopping', labelKey: 'nav.shoppingList' },
  { to: '/import', labelKey: 'nav.import' },
  { to: '/library/ingredients', labelKey: 'nav.library' },
];

const IDLE_LINK = "flex items-center gap-3 px-4 py-3 text-zinc-500 hover:bg-zinc-50 rounded-xl font-semibold text-sm transition-all group";
const ACTIVE_LINK = "flex items-center gap-3 px-4 py-3 bg-primary/5 text-primary rounded-xl font-bold text-sm transition-all shadow-sm shadow-primary/5 border border-primary/10";

function LibraryLink({ to, icon, label, active }: { to: string; icon: string; label: string; active: boolean }) {
  return (
    <Link to={to} className={active ? ACTIVE_LINK : IDLE_LINK}>
      <span className={`material-symbols-outlined text-[20px] ${active ? '' : 'group-hover:text-primary transition-colors'}`}>{icon}</span>
      {label}
    </Link>
  );
}

export default function AppLayout({ children, librarySection, sidebarExtra, headerActions }: AppLayoutProps) {
  const { t, i18n } = useTranslation();
  const setContentLang = useStore((s) => s.setContentLang);
  const location = useLocation();

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('smartchef.uiLang', code);
    setContentLang(code);
  };

  // Both the Library top-level link and the individual library sub-pages
  // (Ingredients/Tools/Units) should light up "Library" as the active tab.
  const isActive = (to: string) =>
    to === '/library/ingredients'
      ? location.pathname.startsWith('/library')
      : location.pathname === to;

  return (
    <div className="min-h-screen bg-[#fafaf5] text-zinc-900 font-outfit">
      <header className="h-[65px] bg-white border-b border-zinc-100 flex items-center justify-between px-8 sticky top-0 z-50">
        <div className="flex items-center gap-12">
          <Link to="/" className="text-2xl font-black text-primary tracking-tight">SmartChef</Link>
          <nav className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={
                  isActive(link.to)
                    ? "text-primary font-bold text-sm border-b-2 border-primary pb-0.5 transition-colors"
                    : "text-zinc-400 font-medium text-sm hover:text-primary transition-colors"
                }
              >
                {t(link.labelKey)}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {headerActions}
          <Link
            to="/recipe/new"
            className="hidden sm:flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full font-bold text-xs shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            {t('nav.createRecipe')}
          </Link>
          <select
            value={i18n.language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            aria-label={t('common.language')}
            className="text-xs font-bold text-zinc-500 bg-zinc-50 rounded-full px-3 py-1.5 border border-zinc-200 focus:ring-2 focus:ring-primary/20 cursor-pointer"
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <div className="w-8 h-8 rounded-full bg-zinc-200 border-2 border-white shadow-sm overflow-hidden shrink-0">
            <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Felix" alt="Chef Avatar" />
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-65px)]">
        {librarySection && (
          <aside className="w-[280px] bg-white border-r border-zinc-100 flex flex-col p-6 sticky top-[65px] h-[calc(100vh-65px)]">
            <div className="mb-8 p-2">
              <h2 className="text-lg font-black text-primary leading-tight">Management</h2>
              <p className="text-[10px] font-bold text-zinc-400 tracking-[0.2em] uppercase">Kitchen Essentials</p>
            </div>
            <nav className="space-y-1">
              <LibraryLink to="/library/ingredients" icon="restaurant" label={t('nav.ingredients')} active={librarySection === 'ingredients'} />
              <LibraryLink to="/library/tools" icon="construction" label={t('nav.tools')} active={librarySection === 'tools'} />
              <LibraryLink to="/library/units" icon="straighten" label={t('nav.units')} active={librarySection === 'units'} />
              <LibraryLink to="/library/techniques" icon="whatshot" label={t('nav.techniques')} active={librarySection === 'techniques'} />
              {sidebarExtra}
            </nav>
          </aside>
        )}
        <main className={librarySection ? "flex-grow p-10 max-w-7xl mx-auto" : "flex-grow"}>
          {children}
        </main>
      </div>
    </div>
  );
}
