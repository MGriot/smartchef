import { useEffect, useState } from 'react';
import { DEFAULT_SORT, isLibrarySortKey, type LibrarySortKey } from '../lib/librarySort';

export type LibraryViewMode = 'grid' | 'list';

/** Which Library screen's preferences these are. Used as the localStorage
 *  key suffix, so each section remembers its own choice — a grid of tool
 *  photos and a table of unit conversions do not want the same default. */
export type LibrarySection = 'ingredients' | 'tools' | 'units' | 'techniques' | 'tags' | 'seasonality';

const KEY = (section: LibrarySection, field: 'view' | 'sort') => `smartchef.library.${section}.${field}`;

/** Remembers each Library section's view mode and sort order across visits
 *  and restarts.
 *
 *  localStorage rather than the database on purpose: "I like this screen as
 *  a grid" is this device's business, not a fact about the library, and
 *  syncing it would mean a phone and a desktop fighting over one value for
 *  screens whose sensible default differs by screen size. Same reasoning
 *  (and same key prefix style) as the gallery's own `smartchef.galleryGridCols`.
 *
 *  Every read and write is guarded: a private window or blocked site data
 *  makes localStorage throw on access rather than return null, and a Library
 *  screen must still render in that case. */
export function useLibraryView(section: LibrarySection, defaultView: LibraryViewMode = 'grid') {
  const [view, setView] = useState<LibraryViewMode>(() => {
    try {
      const saved = localStorage.getItem(KEY(section, 'view'));
      return saved === 'grid' || saved === 'list' ? saved : defaultView;
    } catch {
      return defaultView;
    }
  });

  const [sort, setSort] = useState<LibrarySortKey>(() => {
    try {
      const saved = localStorage.getItem(KEY(section, 'sort'));
      // Validated rather than trusted: a preference persisted by an older
      // build could name a sort this version no longer has, which would
      // otherwise leave the list in whatever order the source array held.
      return isLibrarySortKey(saved) ? saved : DEFAULT_SORT;
    } catch {
      return DEFAULT_SORT;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(KEY(section, 'view'), view);
    } catch {
      /* nothing worth failing a page render over */
    }
  }, [section, view]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY(section, 'sort'), sort);
    } catch {
      /* as above */
    }
  }, [section, sort]);

  return { view, setView, sort, setSort };
}
