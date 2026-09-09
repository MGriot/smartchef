import { resolveIcon } from '../lib/icons';

/** Draws a stored icon name. Kept under its original name because it is
 *  referenced from a dozen call sites; the Font Awesome specifics moved to
 *  lib/icons.ts, which also translates the FA6 names older records carry. */
export default function RenderFaIcon({ name, className = '', color }: { name: string; className?: string; color?: string | null }) {
  const IconComponent = resolveIcon(name);
  const style = color ? { color } : undefined;
  return <IconComponent className={className} style={style} />;
}
