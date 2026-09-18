import React from 'react';

/** A page's own actions on a phone/tablet, floating at the bottom of the
 *  screen instead of crowding the top bar. The top bar only has room for
 *  the menu, the app name and the avatar at phone width — six recipe icons
 *  on top of that used to spill across the "SmartChef" name.
 *
 *  Hidden from `lg` up, where the same actions render in the header again
 *  (AppLayout's `headerActions`). A page using this must leave
 *  `FLOATING_ACTION_BAR_CLEARANCE` of padding at the bottom of its content,
 *  or the bar would sit on top of the last section when scrolled to the end. */
export default function FloatingActionBar({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    // Centered with left/right + mx-auto + w-fit, and a solid background —
    // never a translate or a backdrop blur. Either one makes this bar the
    // containing block for `position: fixed` descendants, which squeezed
    // the share/collection menus (and their tap-outside-to-close backdrop)
    // into the bar's own 250px instead of the screen.
    <div
      role="toolbar"
      aria-label={label}
      className="no-print lg:hidden fixed inset-x-0 mx-auto w-fit z-40 max-w-[calc(100vw-2rem)] flex items-center gap-1 px-2 py-1.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg shadow-black/10 dark:shadow-black/40"
      style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
    >
      {children}
    </div>
  );
}

/** Bottom padding a page needs so its last content ends above the bar:
 *  the bar (~52px) + its 1rem offset + breathing room + the gesture area. */
export const FLOATING_ACTION_BAR_CLEARANCE = 'calc(6rem + env(safe-area-inset-bottom))';
