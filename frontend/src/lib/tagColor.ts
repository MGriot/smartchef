// ════════════════════════════════════════════════════════════════════════
// SmartChef — Readable text on a tag's own color
//
// Tags carry a user-picked background color and were always lettered in
// white, so a pale one (a cheese-yellow, a pastel) came out unreadable.
// ════════════════════════════════════════════════════════════════════════

const DARK_TEXT = '#18181b';
const LIGHT_TEXT = '#ffffff';

/** White or near-black, whichever reads on `background` (a #rgb or
 *  #rrggbb color). Anything unparseable gets white, the old default. */
export function tagTextColor(background: string | null | undefined): string {
  const hex = background?.trim().replace(/^#/, '') ?? '';
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return LIGHT_TEXT;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Where white and near-black give equal contrast (WCAG ratios).
  return luminance > 0.18 ? DARK_TEXT : LIGHT_TEXT;
}
