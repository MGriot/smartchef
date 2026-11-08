import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatQuantity, parseQuantityStrict } from '../lib/ingredientAmount';

interface QuantityInputProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  /** Picks the form an existing amount is shown in: "1 ½" for a cup,
   *  "250" for grams. */
  unitSymbol?: string | null;
  className?: string;
  placeholder?: string;
}

/**
 * An amount field that takes what a cook actually types — "3", "1,5",
 * "3/4", "1 1/2", "½" — rather than the number-only input it replaces,
 * which refused anything with a slash. The typed text is kept while the
 * field is being edited, so "1 1/" isn't rewritten under the cursor; the
 * parent only ever sees a number (or null for an empty field), and an
 * input that doesn't parse is flagged and left out of the draft.
 */
export default function QuantityInput({ value, onChange, unitSymbol, className = '', placeholder }: QuantityInputProps) {
  const { t } = useTranslation();
  const shown = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '' : formatQuantity(v, unitSymbol));
  const [text, setText] = useState(() => shown(value));
  const parsed = parseQuantityStrict(text);
  const invalid = parsed === undefined;

  // Follow outside changes (an AI fix, a reset) without clobbering what is
  // being typed: only when the text no longer means the value.
  useEffect(() => {
    const current = parseQuantityStrict(text);
    const next = value == null || Number.isNaN(value) ? null : value;
    if (current === undefined) return;
    if (current === next || (current != null && next != null && Math.abs(current - next) < 0.0001)) return;
    setText(shown(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      placeholder={placeholder}
      title={invalid ? t('editors.quantityInvalid') : t('editors.quantityHint')}
      aria-invalid={invalid || undefined}
      onChange={e => {
        setText(e.target.value);
        const next = parseQuantityStrict(e.target.value);
        if (next !== undefined) onChange(next);
      }}
      onBlur={() => {
        if (parsed !== undefined) setText(shown(parsed));
      }}
      className={`${className}${invalid ? ' ring-2 ring-red-400/60' : ''}`}
    />
  );
}
