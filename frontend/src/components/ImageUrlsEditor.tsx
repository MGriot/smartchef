import React, { useState } from 'react';

interface ImageUrlsEditorProps {
  urls: string[];
  onChange: (urls: string[]) => void;
}

/**
 * Add/remove one or more reference photo URLs, with live thumbnail previews.
 * No file upload backend exists yet, so this takes URLs (same pattern as
 * a recipe's cover image) rather than raw file uploads.
 */
export default function ImageUrlsEditor({ urls, onChange }: ImageUrlsEditorProps) {
  const [draft, setDraft] = useState('');

  const addUrl = () => {
    const trimmed = draft.trim();
    if (!trimmed || urls.includes(trimmed)) return;
    onChange([...urls, trimmed]);
    setDraft('');
  };

  const removeUrl = (url: string) => onChange(urls.filter(u => u !== url));

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <input
          type="url"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
          placeholder="https://…"
          className="flex-1 px-4 py-2.5 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
        />
        <button
          type="button"
          onClick={addUrl}
          disabled={!draft.trim()}
          className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center disabled:opacity-30 shrink-0"
        >
          <span className="material-symbols-outlined text-lg">add</span>
        </button>
      </div>
      {urls.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {urls.map(url => (
            <div key={url} className="relative group w-16 h-16 rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50">
              <img src={url} alt="" className="w-full h-full object-cover" onError={e => (e.currentTarget.style.opacity = '0.2')} />
              <button
                type="button"
                onClick={() => removeUrl(url)}
                className="absolute inset-0 bg-zinc-900/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
                <span className="material-symbols-outlined text-white text-lg">delete</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
