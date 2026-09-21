import React, { useCallback, useEffect, useRef, useState } from 'react';

/** A page's own actions on a phone/tablet, as a floating button that fans
 *  them onto an arc — instead of crowding the top bar, where at phone width
 *  there is only room for the menu, the app name and the avatar.
 *
 *  Hidden from `lg` up, where the same actions render in the header again
 *  (AppLayout's `headerActions`). A page using this must leave
 *  `FLOATING_ACTION_BAR_CLEARANCE` of padding at the bottom of its content.
 *
 *  ── Why an arc and not the row this used to be ──────────────────────────
 *  The row was a permanent 250px pill sitting over the recipe. With seven
 *  actions it filled most of a 390px screen, and every one of them was an
 *  unlabelled icon competing with the content behind it. Collapsed to one
 *  button, the page is readable; opened, each action gets a 44px target on
 *  a quarter arc where nothing overlaps anything.
 *
 *  ── Two constraints that are easy to break ──────────────────────────────
 *  1. NO `transform`, `filter`, `backdrop-filter` or `will-change` on this
 *     component or any wrapper around the children. Each creates a
 *     containing block for `position: fixed` descendants, and the
 *     share/collection popovers inside these very buttons are fixed — they
 *     got squeezed into the old bar's own 250px, backdrop and all. The
 *     entrance animation is therefore opacity-only (which makes a stacking
 *     context, not a containing block) and the arc positions are plain
 *     `right`/`bottom` offsets.
 *  2. Solid background, never a blur, for the same reason.
 */

/** Half of the 44px (w-11) action buttons, to centre them on the arc. */
const HALF_ACTION = 22;
/** Centre-to-centre gap along the arc. The buttons are 44px, so anything
 *  below that overlaps them — at 96px fixed radius, seven actions sat 25px
 *  apart and piled on top of each other. */
const MIN_SPACING = 52;
/** Never tighter than this, so two or three actions do not sit in the
 *  button's own lap. */
const MIN_RADIUS = 96;
/** A quarter turn: straight up to straight left. Going further would put
 *  actions below the button, off the bottom of a short screen. */
const SWEEP = Math.PI / 2;

/** The arc grows with the number of actions rather than crowding them into
 *  a fixed one. Seven actions (the most a recipe shows) need ~200px; two
 *  need nothing like it. */
function arcRadius(count: number): number {
  if (count <= 1) return MIN_RADIUS;
  return Math.max(MIN_RADIUS, (MIN_SPACING * (count - 1)) / SWEEP);
}

/** The individual actions, however the caller grouped them.
 *
 *  React.Children.toArray does NOT look inside a fragment — it returns the
 *  fragment as ONE child. RecipeDetail's renderActions() returns exactly
 *  that, so without this every action landed in a single seat on the arc,
 *  stacked on top of each other, and the fan did not happen at all. It
 *  looked fine in isolation because a caller passing a plain array works. */
function flattenChildren(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) =>
    React.isValidElement(child) && child.type === React.Fragment
      ? flattenChildren((child.props as { children?: React.ReactNode }).children)
      : [child],
  );
}

export default function FloatingActionBar({ children, label }: { children: React.ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const actions = flattenChildren(children).filter(Boolean);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Pointer rather than click: a tap that lands on the page behind should
    // close the arc without also activating whatever it landed on.
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  /** Where the i-th action sits on the quarter arc from straight up to
   *  straight left. A single action goes straight up rather than to the
   *  midpoint, which would put it diagonally over the content for no
   *  reason. */
  const radius = arcRadius(actions.length);
  const seat = (index: number): { right: number; bottom: number } => {
    const t = actions.length <= 1 ? 0 : index / (actions.length - 1);
    const angle = t * SWEEP;
    return {
      right: radius * Math.sin(angle) - HALF_ACTION,
      bottom: radius * Math.cos(angle) - HALF_ACTION,
    };
  };

  return (
    <div
      ref={rootRef}
      className="no-print lg:hidden fixed z-40"
      style={{ right: '1.25rem', bottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
    >
      <div
        role="toolbar"
        aria-label={label}
        aria-hidden={!open}
        // The arc's own origin is the button's centre, so each action is
        // placed by offset from there. Zero-sized and pointer-transparent
        // when closed so it never intercepts a tap on the page.
        className="absolute"
        style={{ right: 28, bottom: 28, width: 0, height: 0, pointerEvents: open ? 'auto' : 'none' }}
      >
        {actions.map((action, index) => {
          const { right, bottom } = seat(index);
          return (
            <div
              key={index}
              // Closed: every action sits under the button and invisible,
              // so opening reads as them coming out of it.
              className="absolute transition-all duration-200 ease-out"
              style={{
                right: open ? right : -HALF_ACTION,
                bottom: open ? bottom : -HALF_ACTION,
                opacity: open ? 1 : 0,
                // Staggered, nearest first.
                transitionDelay: open ? `${index * 25}ms` : '0ms',
              }}
              onClick={close}
            >
              <div className="rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg shadow-black/10 dark:shadow-black/40">
                {action}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative w-14 h-14 rounded-full bg-primary text-white shadow-lg shadow-black/20 flex items-center justify-center active:scale-95 transition-transform"
      >
        {/* No rotation: `close` is already an X, and turning it 45 degrees
            made it a plus sign. */}
        <span className="material-symbols-outlined text-[26px]">
          {open ? 'close' : 'more_horiz'}
        </span>
      </button>
    </div>
  );
}

/** Bottom padding a page needs so its last content ends above the button:
 *  the button (56px) + its offset + breathing room + the gesture area. */
export const FLOATING_ACTION_BAR_CLEARANCE = 'calc(7rem + env(safe-area-inset-bottom))';
