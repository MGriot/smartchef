import React, { useEffect, useRef, useState } from 'react';

export interface AutocompleteOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface AutocompleteProps {
  options: AutocompleteOption[];
  value: string | null;
  onSelect: (id: string, label: string) => void;
  onClear?: () => void;
  placeholder?: string;
  className?: string;
  // When provided, a "Create '<query>'" row appears below the matches
  // whenever the typed text doesn't exactly match an existing option —
  // the caller is responsible for creating the item (e.g. POST
  // /api/ingredients) and then calling onSelect() with the new id/name
  // itself; this component doesn't know how to create anything.
  onCreateNew?: (query: string) => void;
  createNewLabel?: (query: string) => string;
  // A parsed-but-not-yet-matched name to show (and let the user search/
  // create from) when there's no `value` id at all — e.g. an ingredient
  // that came from pasted raw-text JSON with a name but no library id yet.
  // Without this the box just looked empty, giving no hint that anything
  // needed resolving.
  unmatchedLabel?: string;
}

/**
 * Type-to-search combobox: shows live suggestions as you type, Enter/click
 * to pick, arrow keys to move through matches. Falls back to the plain text
 * typed so far if nothing is selected yet.
 */
export default function Autocomplete({ options, value, onSelect, onClear, placeholder, className, onCreateNew, createNewLabel, unmatchedLabel }: AutocompleteProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the displayed text in sync when the selected value changes from outside
  // (e.g. loading an existing recipe) without clobbering what the user is typing.
  useEffect(() => {
    const selected = options.find(o => o.id === value);
    setQuery(selected ? selected.label : (unmatchedLabel ?? ''));
    // An unmatched row needs a decision (pick an existing match or create
    // new) — open the dropdown immediately instead of waiting for the user
    // to click in, so that decision is visible right away rather than
    // looking like a plain pre-filled text field.
    if (!selected && unmatchedLabel) setOpen(true);
  }, [value, options, unmatchedLabel]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const matches = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30)
    : options.slice(0, 30);

  const trimmedQuery = query.trim();
  const showCreateNew = !!(onCreateNew && trimmedQuery && !options.some(o => o.label.toLowerCase() === trimmedQuery.toLowerCase()));

  const handleCreateNew = () => {
    if (!onCreateNew) return;
    onCreateNew(trimmedQuery);
    setOpen(false);
  };

  const handleSelect = (opt: AutocompleteOption) => {
    onSelect(opt.id, opt.label);
    setQuery(opt.label);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[highlight]) handleSelect(matches[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={e => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
          if (!e.target.value && onClear) onClear();
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={className}
      />
      {open && (matches.length > 0 || showCreateNew) && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-zinc-100 dark:border-zinc-800 py-1">
          {matches.map((opt, i) => (
            <button
              type="button"
              key={opt.id}
              onMouseDown={e => e.preventDefault()}
              onClick={() => handleSelect(opt)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                i === highlight ? 'bg-primary/10 text-primary' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900'
              }`}
            >
              {opt.label}
              {opt.sublabel && <span className="text-zinc-400 dark:text-zinc-500 text-xs ml-2">{opt.sublabel}</span>}
            </button>
          ))}
          {showCreateNew && (
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={handleCreateNew}
              className="w-full text-left px-4 py-2 text-sm font-bold text-primary hover:bg-primary/5 transition-colors border-t border-zinc-100 dark:border-zinc-800"
            >
              {createNewLabel ? createNewLabel(trimmedQuery) : `+ Create "${trimmedQuery}"`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
