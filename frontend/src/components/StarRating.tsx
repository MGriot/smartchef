import React from 'react';

interface StarRatingProps {
  value: number | null | undefined;
  onChange: (rating: number | null) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

export default function StarRating({ value, onChange, size = 'md', disabled }: StarRatingProps) {
  const starSize = size === 'sm' ? 'text-[18px]' : 'text-[24px]';
  const stars = [1, 2, 3, 4, 5];

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center">
        {stars.map((n) => {
          const filled = value !== null && value !== undefined && n <= value;
          return (
            <button
              key={n}
              type="button"
              disabled={disabled}
              onClick={() => onChange(value === n ? n - 1 : n)}
              title={`${n} star${n === 1 ? '' : 's'}`}
              className="disabled:cursor-default"
            >
              <span
                className={`material-symbols-outlined ${starSize} ${filled ? 'text-amber-400' : 'text-zinc-300 dark:text-zinc-600'} transition-colors`}
                style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                star
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(null)}
        title="Not tried yet"
        className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-colors disabled:cursor-default ${
          value === null || value === undefined ? 'bg-zinc-900 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700'
        }`}
      >
        N/A
      </button>
    </div>
  );
}
