import React, { useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

interface ImageUrlsEditorProps {
  urls: string[];
  onChange: (urls: string[]) => void;
}

/**
 * Add/remove one or more reference photo URLs, with live thumbnail previews.
 * Photos can either be linked (pasted URL) or uploaded — an upload is sent
 * to POST /api/uploads (resized/recompressed server-side to WebP) and the
 * returned same-origin URL is appended just like a pasted one.
 */
export default function ImageUrlsEditor({ urls, onChange }: ImageUrlsEditorProps) {
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addUrl = (url?: string) => {
    const trimmed = (url ?? draft).trim();
    if (!trimmed || urls.includes(trimmed)) return;
    onChange([...urls, trimmed]);
    setDraft('');
  };

  const removeUrl = (url: string) => onChange(urls.filter(u => u !== url));

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/uploads', { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok || !json.data?.url) throw new Error(json.error ? JSON.stringify(json.error) : 'Upload failed');
      addUrl(json.data.url);
    } catch (err) {
      console.error('Image upload failed:', err);
      // Standalone mode (no server configured) has no local upload path
      // yet — apiFetch() throws "No server configured" for /api/uploads
      // there, same as it would for any other server-only endpoint. That
      // used to be swallowed into a console.error only, so clicking
      // Upload looked like it silently did nothing. Surfaced here instead
      // of building local image storage, which is its own separate,
      // not-yet-designed feature (standalone mode still has no on-device
      // image storage for any entity, recipes included).
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

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
          onClick={() => addUrl()}
          disabled={!draft.trim()}
          className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center disabled:opacity-30 shrink-0"
        >
          <span className="material-symbols-outlined text-lg">add</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="shrink-0 flex items-center gap-1.5 px-4 rounded-xl bg-zinc-100 text-zinc-600 text-sm font-bold hover:bg-zinc-200 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">{uploading ? 'sync' : 'upload'}</span>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {uploadError && (
        <p className="text-xs text-red-600 font-medium mb-3">{uploadError}</p>
      )}
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
