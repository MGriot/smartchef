import React, { useState } from 'react';

interface SynonymsEditorProps {
  value: string[];
  onChange: (synonyms: string[]) => void;
}

/** Chip list of alternate names — type one, press Enter or comma to add.
 *  Shared by the Ingredients/Tools/Tags/Techniques edit modals so a search
 *  for either name finds the same catalog row. Purely search metadata —
 *  never shown anywhere the canonical name already is. */
export default function SynonymsEditor({ value, onChange }: SynonymsEditorProps) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!value.some(v => v.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...value, trimmed]);
    }
    setDraft('');
  };

  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((s, idx) => (
          <span key={idx} className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-100 text-zinc-600">
            {s}
            <button type="button" onClick={() => remove(idx)} className="hover:text-red-500">
              <span className="material-symbols-outlined text-[13px] block">close</span>
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={draft}
        onChange={e => {
          if (e.target.value.endsWith(',')) { setDraft(e.target.value.slice(0, -1)); return; }
          setDraft(e.target.value);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
        }}
        onBlur={commit}
        placeholder="Type a synonym and press Enter…"
        className="w-full border-none bg-zinc-50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}
