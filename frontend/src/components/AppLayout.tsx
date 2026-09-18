import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { useLanguages, useUiAndContentLanguage } from '../hooks/useLanguages';
import OfflineBanner from './OfflineBanner';
import CoverImage from './CoverImage';

type LibrarySection = 'ingredients' | 'tools' | 'units' | 'techniques' | 'tags' | 'seasonality';

interface AppLayoutProps {
  children: React.ReactNode;
  /** When set, renders the "Management" library sidebar with this section highlighted. */
  librarySection?: LibrarySection;
  /** Extra content appended below the static library nav (e.g. the dynamic categories list). */
  sidebarExtra?: React.ReactNode;
  /** Extra content rendered in the header's right-hand action area, before the language switcher. */
  headerActions?: React.ReactNode;
}

// Ordered by what you're doing, not by when each page was built.
//
// Browsing first — Gallery and Atlas are the same recipes, one as a grid
// and one on a map, so they belong next to each other rather than at
// opposite ends. Then the week in the order it actually happens: plan it,
// shop for it, log what you cooked. The two maintenance surfaces come last,
// since Import is occasional (the header's Create Recipe covers the common
// case) and Library is upkeep rather than daily use.
//
// `secondary` is about horizontal budget, not importance. Eight links, a
// Create Recipe button, a language picker and an avatar need roughly 1340px
// laid out flat — but the nav appeared from `lg` (1024px). In the 300px in
// between, flex items shrink below their own content, the labels wrap, and
// `min-h-[65px]` lets the header grow into a second row: the cramped,
// two-line header this fixes. It bites hardest in Italian, French and
// Spanish, whose labels are the longest ("Lista della Spesa", "Liste de
// Courses") — i.e. exactly where an English-speaking dev is least likely to
// see it.
//
// So the three least-frequent destinations hold back until `xl`, where the
// budget is real. Nothing becomes unreachable: the menu button stays visible
// until `xl` too, and its panel always lists every link.
const NAV_LINKS: { to: string; labelKey: string; secondary?: boolean }[] = [
  { to: '/', labelKey: 'nav.gallery' },
  { to: '/atlas', labelKey: 'nav.atlas' },
  { to: '/planner', labelKey: 'nav.planner' },
  { to: '/pantry', labelKey: 'nav.pantry' },
  { to: '/shopping', labelKey: 'nav.shoppingList' },
  { to: '/history', labelKey: 'nav.history', secondary: true },
  { to: '/import', labelKey: 'nav.import', secondary: true },
  { to: '/library/ingredients', labelKey: 'nav.library', secondary: true },
];

const IDLE_LINK = "flex items-center gap-3 px-4 py-3 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl font-semibold text-sm transition-all group";
const ACTIVE_LINK = "flex items-center gap-3 px-4 py-3 bg-primary/5 text-primary rounded-xl font-bold text-sm transition-all shadow-sm shadow-primary/5 border border-primary/10";

function LibraryLink({ to, icon, label, active }: { to: string; icon: string; label: string; active: boolean }) {
  return (
    <Link to={to} className={active ? ACTIVE_LINK : IDLE_LINK}>
      <span className={`material-symbols-outlined text-[20px] ${active ? '' : 'group-hover:text-primary transition-colors'}`}>{icon}</span>
      {label}
    </Link>
  );
}

// Bundled locally (not a remote fetch) so it always renders offline/native.
const DEFAULT_AVATAR = '/chef.svg';

export default function AppLayout({ children, librarySection, sidebarExtra, headerActions }: AppLayoutProps) {
  const { t } = useTranslation();
  // The picker reflects the CONTENT language now, not i18n.language: those
  // two can legitimately differ once a user adds a language with no UI bundle.
  const contentLang = useStore((s) => s.contentLang);
  const account = useStore((s) => s.account);
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Below `lg` the header's own nav links are hidden entirely, and between
  // `lg` and `xl` only the primary five show (see NAV_LINKS) — so this
  // dropdown is the only way to reach the rest until `xl`, and it must close
  // itself whenever a link inside it is actually followed.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const { languages } = useLanguages();

  // Shared with the recipe page's own picker — see useUiAndContentLanguage().
  const handleLanguageChange = useUiAndContentLanguage();

  // Both the Library top-level link and the individual library sub-pages
  // (Ingredients/Tools/Units) should light up "Library" as the active tab.
  const isActive = (to: string) =>
    to === '/library/ingredients'
      ? location.pathname.startsWith('/library')
      : location.pathname === to;

  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-outfit">
      {/* The horizontal padding has to be classes rather than the inline
          style it used to be, because an inline style can't have breakpoints
          — and a flat 2rem per side costs 64px of a 360px phone screen. The
          arbitrary values keep the safe-area floor the inline style gave.
          paddingTop stays inline: it has no responsive variant to express.

          Below `lg` the bar is `fixed`, not sticky: on a phone it must never
          move, and a sticky header silently stops sticking the moment any
          ancestor becomes a scroll container (html/body's overflow-x once did
          exactly that). Its paddingTop also paints the status-bar strip, so
          scrolled content can't show through there. The spacer after it
          reserves the same height in the flow — see --app-header-h. */}
      <header
        className="min-h-[65px] bg-white dark:bg-zinc-900 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2 fixed inset-x-0 top-0 lg:sticky z-50 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] lg:pl-[max(2rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))]"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center gap-3 lg:gap-6 xl:gap-10 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label={t('common.menu')}
            aria-expanded={mobileMenuOpen}
            className="xl:hidden w-9 h-9 -ml-1.5 flex items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 active:scale-95 transition-all shrink-0"
          >
            <span className="material-symbols-outlined">{mobileMenuOpen ? 'close' : 'menu'}</span>
          </button>
          <Link to="/" className="text-xl lg:text-2xl font-black text-primary tracking-tight truncate min-w-0">SmartChef</Link>
          <nav className="hidden lg:flex items-center gap-4 xl:gap-6 2xl:gap-8">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                // whitespace-nowrap + shrink-0 are the actual fix for the
                // two-line header: without them a flex item is free to shrink
                // under its own content and let the label wrap.
                className={`whitespace-nowrap shrink-0 ${link.secondary ? 'hidden xl:inline' : ''} ${
                  isActive(link.to)
                    ? "text-primary font-bold text-sm border-b-2 border-primary pb-0.5 transition-colors"
                    : "text-zinc-400 dark:text-zinc-500 font-medium text-sm hover:text-primary transition-colors"
                }`}
              >
                {t(link.labelKey)}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 xl:gap-4 shrink-0">
          {/* Only from `lg`: below it a page's actions live in its own
              FloatingActionBar, leaving this bar just menu, name and avatar. */}
          {headerActions && <div className="hidden lg:flex items-center gap-3 xl:gap-4">{headerActions}</div>}
          {/* Icon-only until xl, where the label fits without squeezing the
              nav. `title` carries the same text for a hover or long-press. */}
          <Link
            to="/recipe/new"
            title={t('nav.createRecipe')}
            className="hidden sm:flex items-center gap-1.5 px-3 xl:px-4 py-2 bg-primary text-white rounded-full font-bold text-xs shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span className="hidden xl:inline">{t('nav.createRecipe')}</span>
          </Link>
          <select
            value={contentLang}
            onChange={(e) => handleLanguageChange(e.target.value)}
            aria-label={t('common.language')}
            className="hidden sm:block max-w-[6.5rem] xl:max-w-none truncate text-xs font-bold text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 rounded-full pl-2.5 pr-6 xl:pl-3 xl:pr-7 py-1.5 border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 cursor-pointer"
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <Link
            to="/account"
            title={account?.name ?? t('common.account')}
            className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 border-2 border-white shadow-sm overflow-hidden shrink-0 hover:ring-2 hover:ring-primary/30 transition-all"
          >
            <CoverImage src={account?.avatarUrl} alt={account?.name ?? t('common.account')} className="w-full h-full object-cover" fallbackSrc={DEFAULT_AVATAR} />
          </Link>
        </div>
      </header>
      <div className="lg:hidden shrink-0" style={{ height: 'var(--app-header-h)' }} aria-hidden="true" />
      {/* Under the bar rather than above it: above, it would sit beneath the
          fixed header on a phone and never be seen. */}
      <OfflineBanner />

      {/* Below `lg` the header is fixed, so the menu has to be too — in the
          flow it would open wherever the page happens to be scrolled to. */}
      {mobileMenuOpen && (
        <nav className="xl:hidden bg-white dark:bg-zinc-900 border-b border-zinc-100 dark:border-zinc-800 px-4 py-3 space-y-1 shadow-sm max-lg:fixed max-lg:inset-x-0 max-lg:z-40 max-lg:top-[var(--app-header-h)] max-lg:max-h-[calc(100dvh-var(--app-header-h))] max-lg:overflow-y-auto">
          {/* The header's own picker is hidden below `sm` to keep the bar to
              menu, name and avatar; this is where it lives there instead. */}
          <label className="sm:hidden flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[20px]">translate</span>
              {t('common.language')}
            </span>
            <select
              value={contentLang}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="text-xs font-bold text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800 rounded-full pl-3 pr-7 py-1.5 border border-zinc-200 dark:border-zinc-700"
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </label>
          <Link
            to="/recipe/new"
            className="flex items-center gap-3 px-4 py-3 bg-primary text-white rounded-xl font-bold text-sm mb-2"
          >
            <span className="material-symbols-outlined text-[20px]">add</span>
            {t('nav.createRecipe')}
          </Link>
          {NAV_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className={isActive(link.to) ? ACTIVE_LINK : IDLE_LINK}>
              {t(link.labelKey)}
            </Link>
          ))}
          {librarySection && (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] font-black text-zinc-400 dark:text-zinc-500 tracking-[0.2em] uppercase">{t('library.management')}</p>
              <LibraryLink to="/library/ingredients" icon="restaurant" label={t('nav.ingredients')} active={librarySection === 'ingredients'} />
              <LibraryLink to="/library/tools" icon="construction" label={t('nav.tools')} active={librarySection === 'tools'} />
              <LibraryLink to="/library/units" icon="straighten" label={t('nav.units')} active={librarySection === 'units'} />
              <LibraryLink to="/library/techniques" icon="whatshot" label={t('nav.techniques')} active={librarySection === 'techniques'} />
              <LibraryLink to="/library/tags" icon="sell" label={t('nav.tags')} active={librarySection === 'tags'} />
              <LibraryLink to="/library/seasonality" icon="calendar_month" label={t('nav.seasonality')} active={librarySection === 'seasonality'} />
            </>
          )}
        </nav>
      )}

      <div className="flex min-h-[calc(100vh-var(--app-header-h))]">
        {librarySection && (
          <aside className="hidden lg:flex w-[280px] shrink-0 bg-white dark:bg-zinc-900 border-r border-zinc-100 dark:border-zinc-800 flex-col p-6 sticky top-[var(--app-header-h)] h-[calc(100vh-var(--app-header-h))]">
            <div className="mb-8 p-2">
              <h2 className="text-lg font-black text-primary leading-tight">{t('library.management')}</h2>
              <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 tracking-[0.2em] uppercase">{t('library.kitchenEssentials')}</p>
            </div>
            <nav className="space-y-1">
              <LibraryLink to="/library/ingredients" icon="restaurant" label={t('nav.ingredients')} active={librarySection === 'ingredients'} />
              <LibraryLink to="/library/tools" icon="construction" label={t('nav.tools')} active={librarySection === 'tools'} />
              <LibraryLink to="/library/units" icon="straighten" label={t('nav.units')} active={librarySection === 'units'} />
              <LibraryLink to="/library/techniques" icon="whatshot" label={t('nav.techniques')} active={librarySection === 'techniques'} />
              <LibraryLink to="/library/tags" icon="sell" label={t('nav.tags')} active={librarySection === 'tags'} />
              <LibraryLink to="/library/seasonality" icon="calendar_month" label={t('nav.seasonality')} active={librarySection === 'seasonality'} />
              {sidebarExtra}
            </nav>
          </aside>
        )}
        <main className={librarySection ? "flex-grow min-w-0 p-4 sm:p-10 max-w-7xl mx-auto" : "flex-grow min-w-0"}>
          {children}
        </main>
      </div>
    </div>
  );
}
