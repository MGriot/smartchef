import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';
import { isStandaloneMode } from '../lib/standalone';
import { storeImage } from '../lib/localImages';
import { useResolvedImageSrc } from '../hooks/useResolvedImageSrc';

interface ImageUrlsEditorProps {
  urls: string[];
  onChange: (urls: string[]) => void;
}

// Each stored value may need its own async resolve (see
// useResolvedImageSrc()) — one hook instance per thumbnail, so this can't
// just be inlined in the .map() below.
function ImageThumbnail({ url, onRemove }: { url: string; onRemove: () => void }) {
  const src = useResolvedImageSrc(url);
  if (!src) return null; // still resolving a local path — nothing to show yet
  return (
    <div className="relative group w-16 h-16 rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
      <img src={src} alt="" className="w-full h-full object-cover" onError={e => (e.currentTarget.style.opacity = '0.2')} />
      <button
        type="button"
        onClick={onRemove}
        className="absolute inset-0 bg-zinc-900/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
      >
        <span className="material-symbols-outlined text-white text-lg">delete</span>
      </button>
    </div>
  );
}

/**
 * Add/remove one or more reference photo URLs, with live thumbnail previews.
 * Photos can either be linked (pasted URL) or uploaded — in standalone mode
 * (no server), an upload is stored locally via lib/localImages.ts's
 * storeImage() and referenced by its content-addressed relative path;
 * otherwise it's sent to POST /api/uploads (resized/recompressed
 * server-side to WebP) and the returned same-origin URL is appended just
 * like a pasted one.
 */
export default function ImageUrlsEditor({ urls, onChange }: ImageUrlsEditorProps) {
  const { t } = useTranslation();
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
      // Standalone mode has no server to POST to — store the image locally
      // instead (content-addressed, see lib/localImages.ts). The resulting
      // relative path resolves to a displayable URL via ImageThumbnail's
      // useResolvedImageSrc() above, same as it does for every other
      // caller of this component.
      if (await isStandaloneMode()) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extHint = file.name.split('.').pop() || file.type.split('/')[1] || '';
        const relPath = await storeImage(bytes, extHint);
        addUrl(relPath);
        return;
      }
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/uploads', { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok || !json.data?.url) throw new Error(json.error ? JSON.stringify(json.error) : t('editors.uploadFailed'));
      addUrl(json.data.url);
    } catch (err) {
      console.error('Image upload failed:', err);
      setUploadError(err instanceof Error ? err.message : t('editors.uploadFailed'));
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
          placeholder={t('editors.urlPlaceholder')}
          className="flex-1 px-4 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
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
          className="shrink-0 flex items-center gap-1.5 px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-sm font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">{uploading ? 'sync' : 'upload'}</span>
          {uploading ? t('common.uploading') : t('common.upload')}
        </button>
      </div>
      {uploadError && (
        <p className="text-xs text-red-600 font-medium mb-3">{uploadError}</p>
      )}
      {urls.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {urls.map(url => (
            <ImageThumbnail key={url} url={url} onRemove={() => removeUrl(url)} />
          ))}
        </div>
      )}
    </div>
  );
}
