// A recipe's references ("Fonti e Riferimenti"): the `sources` list, plus
// the single `source_url` an import leaves behind. Merging recipes must
// never lose one, so every merge path unions them through here.

export interface RecipeSource {
  type: 'url' | 'book' | 'video' | 'other';
  label?: string;
  url?: string;
}

const TYPES = new Set(['url', 'book', 'video', 'other']);

/** The stored value, whatever shape it arrives in (JSON text or array). */
export function parseSources(value: unknown): RecipeSource[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value || '[]'); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: RecipeSource[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === 'string' && r.url.trim() ? r.url.trim() : undefined;
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : undefined;
    if (!url && !label) continue;
    const type = TYPES.has(String(r.type)) ? (r.type as RecipeSource['type']) : url ? 'url' : 'other';
    out.push({ type, ...(label ? { label } : {}), ...(url ? { url } : {}) });
  }
  return out;
}

/** Two spellings of one page compare equal: scheme, "www.", a trailing
 *  slash, the fragment and letter case of the host do not make a new source. */
export function normalizeSourceUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function keyOf(s: RecipeSource): string {
  return s.url ? `u:${normalizeSourceUrl(s.url)}` : `l:${s.type}:${(s.label ?? '').toLowerCase()}`;
}

/** True when `list` already names this source (same page, or for a source
 *  without a link the same kind and label). */
export function hasSource(list: RecipeSource[], source: RecipeSource): boolean {
  const key = keyOf(source);
  return list.some((s) => keyOf(s) === key);
}

/** Every source of every list, first occurrence first, each once. */
export function unionSources(...lists: Array<RecipeSource[] | null | undefined>): RecipeSource[] {
  const seen = new Set<string>();
  const out: RecipeSource[] = [];
  for (const list of lists) {
    for (const s of list ?? []) {
      const key = keyOf(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** An import's `source_url` as a list entry, so it can join the union. */
export function sourceUrlAsEntry(url: unknown): RecipeSource[] {
  return typeof url === 'string' && url.trim() ? [{ type: 'url', url: url.trim() }] : [];
}

/** What a merge leaves on the kept recipe: its own references first, then
 *  everything the duplicate had, including the page each was imported from. */
export function mergedSources(
  kept: { sources?: unknown; source_url?: unknown },
  duplicate: { sources?: unknown; source_url?: unknown },
): RecipeSource[] {
  return unionSources(
    parseSources(kept.sources),
    sourceUrlAsEntry(kept.source_url),
    parseSources(duplicate.sources),
    sourceUrlAsEntry(duplicate.source_url),
  );
}

/** The links worth opening to read what a recipe was based on. */
export function sourceLinks(recipe: { sources?: unknown; source_url?: unknown }): string[] {
  const all = unionSources(sourceUrlAsEntry(recipe.source_url), parseSources(recipe.sources));
  return all.flatMap((s) => (s.url && /^https?:\/\//i.test(s.url) ? [s.url] : []));
}
