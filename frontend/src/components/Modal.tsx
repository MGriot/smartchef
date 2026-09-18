import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/* Every open dialog pushes its id here, so Escape only ever closes the
 * *topmost* one — the ingredient modal can open a category modal on top of
 * itself, and the tag list opens a merge dialog over its editor. */
const openStack: string[] = [];

/* The page-scroll lock is counted separately rather than derived from
 * openStack.length: effect cleanups run in registration order, so by the time
 * a nested dialog released its lock the stack had already dropped it and
 * looked like "nobody left", unfreezing the page under a parent that was
 * still open. */
let scrollLocks = 0;
let scrollLockPrevious = '';

/** Shared dialog shell: backdrop, panel, and a fixed header / scrolling body /
 *  fixed footer.
 *
 *  The dialogs this replaces each scrolled *the whole panel*, title and
 *  buttons included, so a tall form scrolled its own heading away and pinned
 *  the actions back with a `sticky bottom-0` strip that overlapped whatever
 *  field was underneath it. Here only the body scrolls, which is also what
 *  keeps the themed scrollbar inside the panel's rounded edge instead of
 *  running down the outside of it. */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  hero,
  footer,
  children,
  onSubmit,
  zIndex = 100,
  bodyClassName = '',
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  size?: ModalSize;
  /** Full-bleed banner above the header — a cover photo, say. Pinned, like
   *  the header itself, so it doesn't eat the body's scroll. */
  hero?: React.ReactNode;
  /** Rendered in the pinned footer bar. Omit for a dialog with no actions. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** When given, body + footer are wrapped in a <form>, so Enter submits and
   *  a footer `type="submit"` button works without a form= attribute. The
   *  native submit is already prevented before this is called. */
  onSubmit?: (e: React.FormEvent) => void;
  zIndex?: number;
  bodyClassName?: string;
  closeOnBackdrop?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // onClose is an inline arrow at almost every call site, so depending on it
  // directly would re-run the effect below on every render — popping this
  // dialog off the stack and pushing it back on top. A parent re-rendering
  // while its child dialog was open would then take the child's place at the
  // top and steal its Escape.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes, but only the dialog on top of the stack.
  useEffect(() => {
    if (!open) return;
    openStack.push(id);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openStack[openStack.length - 1] !== id) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = openStack.lastIndexOf(id);
      if (at !== -1) openStack.splice(at, 1);
    };
  }, [open, id]);

  // Freeze the page behind the dialog. Without this the wheel keeps scrolling
  // the list underneath once the dialog body hits its end, so closing the
  // dialog drops you somewhere else in the catalog.
  useEffect(() => {
    if (!open) return;
    if (scrollLocks === 0) {
      scrollLockPrevious = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = scrollLockPrevious;
    };
  }, [open]);

  // Focus the first control on open, and hand focus back to whatever opened
  // the dialog on close.
  //
  // Deliberately waits for the entry animation to finish. The panel starts
  // at `opacity: 0` and mid-transform (`.animate-dialog-in`, with
  // fill-mode both), so on the frame this effect runs the thing being
  // focused is invisible — and Chromium 114, which is what the Electron
  // build ships, takes the focus() (document.activeElement updates, so it
  // LOOKS right) without routing key events to it. The dialog then sits
  // there refusing to accept typing until something forces a focus
  // re-commit: alt-tabbing away and back, or — as it was reported — taking
  // a screenshot. Focusing once the panel is actually on screen avoids the
  // whole thing, and costs ~0.22s nobody can act inside anyway.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;

    let cancelled = false;
    const focusFirst = () => {
      const panel = panelRef.current;
      if (cancelled || !panel) return;
      // A click that landed inside while the dialog was animating already
      // said where focus belongs — don't yank it back to the first field.
      if (panel.contains(document.activeElement)) return;
      panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )?.focus({ preventScroll: true });
    };

    const panel = panelRef.current;
    const running = panel?.getAnimations?.() ?? [];
    if (running.length === 0) {
      // prefers-reduced-motion, or a browser with no Web Animations API:
      // nothing is animating, so the panel is already visible.
      focusFirst();
    } else {
      Promise.all(running.map((a) => a.finished)).then(focusFirst, focusFirst);
      // Safety net: a cancelled/never-finishing animation must not leave the
      // dialog permanently unfocused.
      setTimeout(focusFirst, 400);
    }

    return () => {
      cancelled = true;
      restoreFocusTo.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const body = (
    <>
      <div className={`flex-1 overflow-y-auto overscroll-contain px-6 py-6 sm:px-8 ${bodyClassName}`}>
        {children}
      </div>
      {footer && (
        <div className="flex items-center gap-3 border-t border-zinc-100 dark:border-zinc-800 px-6 py-4 sm:px-8">
          {footer}
        </div>
      )}
    </>
  );

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4 sm:p-6" style={{ zIndex }}>
      <div
        className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm animate-backdrop-in"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={`relative flex w-full ${SIZE_CLASS[size]} max-h-[min(90vh,52rem)] flex-col
                    overflow-hidden rounded-[28px] bg-white dark:bg-zinc-900 shadow-2xl
                    border border-zinc-100 dark:border-zinc-800 animate-dialog-in`}
      >
        {hero}
        <div className="flex items-start gap-4 border-b border-zinc-100 dark:border-zinc-800 px-6 pt-6 pb-5 sm:px-8">
          <div className="min-w-0 flex-1">
            <h2
              id={`${id}-title`}
              className="truncate text-2xl font-black tracking-tight text-zinc-900 dark:text-zinc-100"
            >
              {title}
            </h2>
            {subtitle && <p className="sc-hint mt-1.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full
                       text-zinc-400 dark:text-zinc-500 transition-colors
                       hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {onSubmit ? (
          <form
            onSubmit={(e) => {
              // Always stop the native submit here, not in each handler: one
              // that forgets (SetupFileDialog did) reloads the page mid-await,
              // which silently kills whatever the handler was about to do.
              e.preventDefault();
              onSubmit(e);
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ── Footer buttons ───────────────────────────────────────────────────────
   The same cancel/confirm pair appears in every dialog; these keep the
   proportions and the disabled/active states identical across all of them. */

export function ModalCancelButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-2xl bg-zinc-100 dark:bg-zinc-800 py-3.5 font-black
                 text-zinc-600 dark:text-zinc-300 transition-colors
                 hover:bg-zinc-200 dark:hover:bg-zinc-700"
    >
      {children}
    </button>
  );
}

export function ModalSubmitButton({
  children,
  onClick,
  disabled,
  type = 'submit',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'submit' | 'button';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex-[2] rounded-2xl bg-primary py-3.5 font-black text-white shadow-lg shadow-primary/20
                 transition-all hover:bg-primary/90 active:scale-[0.98]
                 disabled:opacity-50 disabled:active:scale-100"
    >
      {children}
    </button>
  );
}

/** Destructive action, kept out of the cancel/confirm pair so it can't be hit
 *  by muscle memory — icon-only, at the far left of the footer. */
export function ModalDeleteButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl
                 bg-red-50 dark:bg-red-950/40 text-red-500 transition-colors
                 hover:bg-red-100 dark:hover:bg-red-950/70 hover:text-red-600"
    >
      <span className="material-symbols-outlined text-[22px]">delete</span>
    </button>
  );
}
