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

export default function ActionMenu({
  open,
  onClose,
  anchorRef,
  title,
  views,
  label,
  initialView = 'main',
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
}) {
  const { t } = useTranslation();
  const [view, setView] = useState(initialView);
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

  const select = (item: ActionItem) => async () => {
    if (item.view) { setView(item.view); return; }
    if (!item.keepOpen) onClose();
    try {
      await item.onSelect?.();
    } catch (err) {
      console.error('Menu action failed:', err);
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] max-sm:bg-black/30" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="fixed z-[61] max-sm:inset-x-3 max-sm:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] sm:w-72 max-h-[min(75vh,36rem)] overflow-y-auto overscroll-contain bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-2"
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
