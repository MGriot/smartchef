import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// ════════════════════════════════════════════════════════════════════════
// The app's one action menu: the gallery card's "…", the recipe page's
// Export and Collection popovers and the "+" chooser all open this.
//
// A popover hanging from its button from `sm` up, a bottom sheet on a phone.
// Rendered through a portal and positioned `fixed`, so neither a card's
// `overflow-hidden` nor the floating action bar (which fades out on every
// tap inside it) can clip or hide it. No `transform` anywhere: a fixed
// child of a transformed ancestor stops being fixed (see FloatingActionBar).
//
// Items are grouped in labelled sections; an item can open a submenu (one
// more list, with a way back) or a view of its own (the collection picker).
//
// Two opt-ins, used by the gallery card's menu:
//   - `spotlightRef`: the page dims at every width except that element (the
//     card the menu belongs to), so it is clear which recipe it acts on.
//     A box-shadow "hole", not a blur: blur is what made the gallery stutter
//     on phone GPUs (see Home.tsx).
//   - `phoneLayout="fan"`: on a phone the main view is a column of round
//     buttons with labels hanging from the button, like the recipe page's
//     floating action bar, instead of a bottom sheet. Submenus still open as
//     the sheet, with a way back to the fan.
// ════════════════════════════════════════════════════════════════════════

export interface ActionItem {
  key: string;
  icon: string;
  label: string;
  /** A second, quieter line under the label. */
  hint?: string;
  onSelect?: () => void | Promise<void>;
  /** Opens this view instead of running something. */
  view?: string;
  danger?: boolean;
  /** Shown highlighted: the state the action would undo is on. */
  active?: boolean;
  disabled?: boolean;
  /** The menu stays open after the action (a toggle the user may want to see flip). */
  keepOpen?: boolean;
}

export interface ActionSection {
  label?: string;
  items: Array<ActionItem | false | null | undefined>;
}

export type ActionView =
  | { title?: string; sections: ActionSection[] }
  | { title?: string; content: ReactNode };

const ITEM = 'w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center gap-2.5 disabled:opacity-50';
const PANEL_WIDTH = 288;
/** Fan geometry: a 44px round button per row, a wider gap between sections. */
const FAN_ROW = 44;
const FAN_GAP = 10;
const FAN_SECTION_GAP = 14;

type Rect = { top: number; left: number; right: number; bottom: number; width: number; height: number };
const sameRect = (a: Rect | null, b: DOMRect) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
const toRect = (r: DOMRect): Rect => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height });

export default function ActionMenu({
  open,
  onClose,
  anchorRef,
  title,
  views,
  label,
  initialView = 'main',
  spotlightRef,
  phoneLayout = 'sheet',
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** The small heading over the main view, e.g. the recipe's title. */
  title?: string;
  /** `main` is the first view; the others are reached from an item's `view`. */
  views: Record<string, ActionView>;
  /** The menu's accessible name. */
  label: string;
  initialView?: string;
  /** Kept bright while everything else dims. */
  spotlightRef?: RefObject<HTMLElement | null>;
  /** How the main view looks below `sm`. */
  phoneLayout?: 'sheet' | 'fan';
}) {
  const { t } = useTranslation();
  const [view, setView] = useState(initialView);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [spotRadius, setSpotRadius] = useState('1.5rem');
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [entered, setEntered] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 640);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => { if (open) setView(initialView); }, [open, initialView]);

  // Under the button, right edges aligned, kept inside the viewport; the
  // height is measured so a menu opened low on the screen opens upward.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      setWide(window.innerWidth >= 640);
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = panelRef.current?.offsetHeight ?? 360;
      const left = Math.min(Math.max(8, rect.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - 8);
      const below = rect.bottom + 6;
      const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, Math.min(rect.top - 6 - height, window.innerHeight - height - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, view, anchorRef]);

  // The spotlight and the fan follow their elements while open: the page
  // can still scroll under the scrim, and the card drops its hover lift the
  // moment the scrim covers it. One rect read per frame, for one element.
  useEffect(() => {
    if (!open || (!spotlightRef && phoneLayout !== 'fan')) return;
    let raf = 0;
    let lastSpot: Rect | null = null;
    let lastAnchor: Rect | null = null;
    const el = spotlightRef?.current;
    if (el) setSpotRadius(getComputedStyle(el).borderRadius || '1.5rem');
    const tick = () => {
      const sr = spotlightRef?.current?.getBoundingClientRect();
      if (sr && !sameRect(lastSpot, sr)) { lastSpot = toRect(sr); setSpot(lastSpot); }
      const ar = anchorRef.current?.getBoundingClientRect();
      if (ar && !sameRect(lastAnchor, ar)) { lastAnchor = toRect(ar); setAnchor(lastAnchor); }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open, spotlightRef, anchorRef, phoneLayout]);

  // The fan's rows slide out from the button one frame after mounting, so
  // the transition has a start to run from.
  useEffect(() => {
    if (!open) { setEntered(false); return; }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, view]);

  // A rotation that changes which layout applies closes the menu rather
  // than reflowing it into the other one under the user's thumb.
  useEffect(() => {
    if (!open || phoneLayout !== 'fan') return;
    const startedWide = window.innerWidth >= 640;
    const onResize = () => { if ((window.innerWidth >= 640) !== startedWide) onCloseRef.current(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, phoneLayout]);

  // Escape closes (or goes back from a submenu); focus moves into the menu
  // and back to the button when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setView((v) => {
        if (v !== initialView) return initialView;
        onCloseRef.current();
        return v;
      });
    };
    window.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[role="menuitem"], button, input, select')?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, initialView]);

  // Arrow keys walk the items, as in any menu.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  };

  if (!open) return null;
  const current = views[view] ?? views[initialView];
  const isSub = view !== initialView;
  const fan = !wide && phoneLayout === 'fan' && !isSub && 'sections' in current;

  const select = (item: ActionItem) => async () => {
    if (item.view) { setView(item.view); return; }
    if (!item.keepOpen) onClose();
    try {
      await item.onSelect?.();
    } catch (err) {
      console.error('Menu action failed:', err);
    }
  };

  const scrim = spotlightRef ? (
    <>
      <div className="app-no-drag fixed inset-0 z-[60]" onClick={onClose} aria-hidden />
      {spot && (
        <div
          aria-hidden
          className="fixed z-[60] pointer-events-none animate-backdrop-in"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            borderRadius: spotRadius,
            boxShadow: '0 0 0 200vmax rgb(0 0 0 / 0.55)',
          }}
        />
      )}
    </>
  ) : (
    <div className="fixed inset-0 z-[60] max-sm:bg-black/30" onClick={onClose} aria-hidden />
  );

  if (fan && 'sections' in current) {
    return createPortal(
      <>
        {scrim}
        <FanColumn
          panelRef={panelRef}
          label={label}
          title={title}
          sections={current.sections}
          anchor={anchor}
          entered={entered}
          onKeyDown={onKeyDown}
          onSelect={select}
        />
      </>,
      document.body,
    );
  }

  return createPortal(
    <>
      {scrim}
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="fixed z-[61] animate-backdrop-in max-sm:inset-x-3 max-sm:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] sm:w-72 max-h-[min(75vh,36rem)] overflow-y-auto overscroll-contain bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-2"
        style={wide && pos ? { top: pos.top, left: pos.left } : undefined}
      >
        {isSub ? (
          <button
            type="button"
            onClick={() => setView(initialView)}
            className="flex w-full items-center gap-1.5 px-2 pt-1 pb-2 text-xs font-black text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            <span className="truncate">{current.title ?? t('common.back')}</span>
          </button>
        ) : title ? (
          <p className="px-3 pt-1 pb-1.5 text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest truncate">{title}</p>
        ) : null}

        {'content' in current ? (
          <div className="p-1">{current.content}</div>
        ) : (
          current.sections.map((section, s) => {
            const items = section.items.filter((i): i is ActionItem => !!i);
            if (!items.length) return null;
            return (
              <div key={section.label ?? s} role="group" aria-label={section.label} className={s > 0 ? 'mt-1 pt-1 border-t border-zinc-100 dark:border-zinc-800' : ''}>
                {section.label && (
                  <p className="px-3 pt-1.5 pb-1 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{section.label}</p>
                )}
                {items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    aria-haspopup={item.view ? 'menu' : undefined}
                    disabled={item.disabled}
                    onClick={select(item)}
                    className={`${ITEM} ${
                      item.danger
                        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                        : item.active
                          ? 'text-primary hover:bg-primary/5'
                          : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[18px] shrink-0">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      {item.hint && <span className="block truncate text-xs font-normal text-zinc-400 dark:text-zinc-500">{item.hint}</span>}
                    </span>
                    {item.view && <span className="material-symbols-outlined text-[18px] shrink-0 text-zinc-400">chevron_right</span>}
                  </button>
                ))}
              </div>
            );
          })
        )}
      </div>
    </>,
    document.body,
  );
}

/** The phone fan: one round button per action, its label in a pill to the
 *  left, stacked under the "…" (or over it, when it sits low on the
 *  screen). Rows move by `top` and fade in, staggered like the floating
 *  action bar's, with no transform (fixed descendants must stay fixed). */
function FanColumn({
  panelRef,
  label,
  title,
  sections,
  anchor,
  entered,
  onKeyDown,
  onSelect,
}: {
  panelRef: RefObject<HTMLDivElement>;
  label: string;
  title?: string;
  sections: ActionSection[];
  anchor: Rect | null;
  entered: boolean;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (item: ActionItem) => () => void;
}) {
  const groups = sections
    .map((section) => section.items.filter((i): i is ActionItem => !!i))
    .filter((items) => items.length > 0);

  // Each row's offset from the column's top edge.
  const rows: { item: ActionItem; offset: number }[] = [];
  let y = 0;
  groups.forEach((items, gi) => {
    if (gi > 0) y += FAN_SECTION_GAP;
    items.forEach((item) => {
      rows.push({ item, offset: y });
      y += FAN_ROW + FAN_GAP;
    });
  });
  const height = y - FAN_GAP;

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const a = anchor ?? { top: 16, bottom: 56, left: vw - 56, right: vw - 16, width: 40, height: 40 };
  const safeBottom = vh - 16;
  const below = a.bottom + 12;
  const above = a.top - 12 - height;
  const top = below + height <= safeBottom ? below : above >= 12 ? above : Math.max(12, safeBottom - height);
  // Rows start stacked on the button and spread out to their seats.
  const origin = a.top + a.height / 2 - FAN_ROW / 2;
  // The round buttons share the "…" button's centre line.
  const right = Math.max(8, vw - (a.left + a.width / 2) - FAN_ROW / 2);

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={title ? `${label}: ${title}` : label}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-[61] pointer-events-none"
    >
      {rows.map(({ item, offset }, i) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          aria-haspopup={item.view ? 'menu' : undefined}
          disabled={item.disabled}
          onClick={onSelect(item)}
          className="pointer-events-auto absolute flex items-center justify-end gap-3 disabled:opacity-50 transition-all duration-200 ease-out focus:outline-none group"
          style={{
            right,
            top: entered ? top + offset : origin,
            height: FAN_ROW,
            opacity: entered ? 1 : 0,
            transitionDelay: `${entered ? i * 25 : 0}ms`,
            maxWidth: `calc(100vw - ${right + 8}px)`,
          }}
        >
          <span
            className={`min-w-0 truncate rounded-full px-3.5 py-2 text-sm font-semibold shadow-lg shadow-black/20 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 group-focus-visible:ring-2 group-focus-visible:ring-primary ${
              item.danger ? 'text-red-600 dark:text-red-400' : item.active ? 'text-primary' : 'text-zinc-800 dark:text-zinc-100'
            }`}
          >
            {item.label}
          </span>
          <span
            className={`shrink-0 rounded-full flex items-center justify-center shadow-lg shadow-black/20 border ${
              item.danger
                ? 'bg-red-600 border-red-600 text-white'
                : item.active
                  ? 'bg-primary border-primary text-white'
                  : 'bg-white dark:bg-zinc-900 border-zinc-100 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200'
            }`}
            style={{ width: FAN_ROW, height: FAN_ROW }}
          >
            <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
