import React, { useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

interface ImageUrlInputProps {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * A single-value image field: a plain URL text input plus an "Upload"
 * button that sends a local file to POST /api/uploads (resized/recompressed
 * server-side to WebP) and writes the returned same-origin URL back into
 * the same value — so callers don't need to distinguish linked vs uploaded
 * images, both are just URLs.
 */
export default function ImageUrlInput({ value, onChange, placeholder = 'https://…', className }: ImageUrlInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/uploads', { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok || !json.data?.url) throw new Error(json.error ? JSON.stringify(json.error) : 'Upload failed');
      onChange(json.data.url);
    } catch (err) {
      console.error('Image upload failed:', err);
      setError('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="url"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={className || 'flex-1 min-w-0 border-none bg-zinc-50 rounded-xl p-4 text-sm focus:ring-2 focus:ring-primary/20'}
        />
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
          className="shrink-0 flex items-center gap-1.5 px-4 rounded-xl bg-zinc-900 text-white text-sm font-bold hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">{uploading ? 'sync' : 'upload'}</span>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {error && <p className="text-xs text-red-500 font-medium mt-1">{error}</p>}
      {value && (
        <div className="mt-3 w-20 h-20 rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50">
          <img src={value} alt="" className="w-full h-full object-cover" onError={e => (e.currentTarget.style.opacity = '0.2')} />
        </div>
      )}
    </div>
  );
}
