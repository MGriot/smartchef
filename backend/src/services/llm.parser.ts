// ════════════════════════════════════════════════════════════════════════
// SmartChef — LLM Parser Service (Ollama)
// Analizza testo/URL di ricette e mappa i campi nel DB
// ════════════════════════════════════════════════════════════════════════

import { Agent, setGlobalDispatcher } from "undici";
import type { LLMParseMedia, LLMParseRequest, LLMParseResult } from "@shared/types/index";
import { queryOne } from "../db/pool";
import { decrypt } from "./crypto.service";
import { callAnthropic, callGemini, callOpenAI } from "./llm.providers";
import { loadImportCatalog, type ImportCatalog } from "./importCatalog.service";

// undici's default headersTimeout/bodyTimeout (300s) fires independently of
// any AbortSignal passed to fetch() — on CPU-only local inference a single
// Ollama call can legitimately run longer than that (non-streaming, so no
// response bytes arrive until generation finishes). Disable undici's own
// timeouts globally and rely solely on the explicit AbortSignal below,
// which is the real ceiling we want enforced.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3";

/** account.ollama_url overrides the server-wide default above when set —
 *  lets a user point at an Ollama instance on a different host/port (e.g.
 *  a beefier machine on the LAN) from Account settings, no server restart
 *  needed. Falls back to the env-var default when null/blank. */
function resolveOllamaUrl(accountOverride?: string | null): string {
  return accountOverride?.trim() || OLLAMA_URL;
}

// ══════════ BEGIN TWIN BLOCK: base prompt ══════════
const SYSTEM_PROMPT_BASE = `Sei un assistente specializzato nell'analisi di ricette culinarie.
Il tuo compito è estrarre informazioni strutturate da testi o pagine web di ricette.
Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, senza testo aggiuntivo.

Il JSON deve avere questa struttura:
{
  "title": "string",
  "language": "string (codice ISO 639-1 della lingua in cui è scritta la ricetta originale, es. it/en/fr/es/de)",
  "description": "string | null",
  "servings": "number | null",
  "prepTimeMin": "number | null",
  "cookTimeMin": "number | null",
  "restTimeMin": "number | null",
  "difficulty": "easy | medium | hard | expert | null",
  "tags": ["string"],
  "tools": ["string"],
  "storageInstructions": "string | null",
  "tips": "string | null",
  "ingredients": [
    {
      "name": "string",
      "catalogName": "string | null (nome della voce di catalogo corrispondente; null se nessuna corrisponde)",
      "quantity": "number | null",
      "quantityText": "string | null",
      "unit": "string | null",
      "notes": "string | null",
      "groupName": "string | null",
      "isOptional": "boolean"
    }
  ],
  "steps": [
    {
      "stepNumber": "number",
      "title": "string | null",
      "description": "string",
      "durationMin": "number | null",
      "techniques": ["string"],
      "ingredients": [
        {
          "name": "string",
          "quantity": "number | null",
          "unit": "string | null"
        }
      ]
    }
  ],
  "imageUrl": "string | null (URL assoluto http/https dell'immagine di copertina del piatto, se una compare nel contenuto; altrimenti null)",
  "confidence": "number (0-1)",
  "warnings": ["string"]
}

Regole:
- restTimeMin è il tempo di attesa/riposo (lievitazione, marinatura, raffreddamento) separato dal tempo di preparazione attiva
- tools è l'elenco degli strumenti/attrezzi da cucina menzionati o chiaramente necessari, con nomi brevi, generici e IN INGLESE (es. "Oven", "Stand Mixer", "Blender"), qualunque sia la lingua della ricetta
- storageInstructions è come conservare gli avanzi ("Come conservare"), tips sono consigli generali distinti dalla description — entrambi null se non menzionati
- groupName (negli ingredienti) è un'intestazione breve e opzionale sotto cui questo ingrediente è raggruppato, es. "Per il condimento" — impostalo SOLO quando la ricetta originale raggruppa visivamente gli ingredienti in sezioni etichettate; altrimenti lascialo null. Non inventare raggruppamenti assenti nella fonte
- isOptional (negli ingredienti) è true quando la ricetta presenta quell'ingrediente come facoltativo o a piacere (es. "facoltativo", "se gradito", "optional", "per guarnire", "q.b. a piacere"); altrimenti false. Non dedurlo dal fatto che una quantità sia vaga
- techniques (negli step) è l'elenco delle tecniche di cottura riconosciute in quello step, con nomi brevi e IN INGLESE (es. "Sauté", "Braise"), stesso criterio di "tools"
- ingredients (negli step) è l'elenco degli ingredienti che QUEL passaggio usa. Il campo name deve essere copiato ESATTAMENTE come compare nella lista "ingredients" principale, altrimenti il collegamento viene scartato. Metti quantity/unit SOLO quando il passaggio usa una parte dichiarata dell'ingrediente (es. "metà dello zucchero" su 100 g -> quantity 50, unit "g"); se il passaggio usa semplicemente l'ingrediente, lascia quantity e unit a null. Non elencare ingredienti che quel passaggio non nomina né usa, e non inventarne di assenti dalla lista principale
- Se una quantità è vaga (es. "q.b.", "a piacere"), metti null in quantity e il testo in quantityText
- Normalizza le unità in italiano (grammi, ml, cucchiai, ecc.)
- Stima la difficoltà basandoti sul numero di step e tecniche usate
- Se non riesci a estrarre un campo, usa null
- Aggiungi warnings per informazioni ambigue o mancanti
- imageUrl: usa SOLO un URL che compare letteralmente nel contenuto (incluso quello proposto come "Immagine di copertina della pagina"), mai inventato. Deve mostrare il piatto finito: scarta loghi, avatar, banner pubblicitari e icone. null se non ce n'è uno adatto
- confidence deve riflettere quanto sei sicuro dell'estrazione (1.0 = perfetto)`;
// ══════════ END TWIN BLOCK: base prompt ══════════

// ══════════ BEGIN TWIN BLOCK: catalog prompt ══════════
// Everything between these markers is PROMPT, not runtime, and is copied
// byte-for-byte between backend/src/services/llm.parser.ts and
// frontend/src/services/llmParser.local.ts. A drift here is a silent
// behaviour fork between server and standalone mode, so
// llmParser.promptParity.test.ts compares the two blocks character by
// character. Edit both, or edit neither.

/** Providers that get the ingredient list too.
 *
 *  Ollama is excluded on purpose, and not to save money. Neither callOllama
 *  sets `options.num_ctx`, so a request runs against Ollama's default
 *  context window (2048 on most builds, 4096 on newer ones) — and the base
 *  prompt plus a 6 000-character recipe already fills most of it. Ollama
 *  does not error when a request overflows; it drops the oldest tokens and
 *  answers from what is left, so a ~2 000-token ingredient list would buy
 *  worse extraction while looking like it worked. Tools and techniques
 *  together are ~320 tokens, which fits — and they are where the
 *  duplication this feature exists to stop actually hurts (see the
 *  "Bollitura next to Boil" note in services/techniques.local.ts).
 *
 *  If you ever want ingredients here: set num_ctx explicitly on the Ollama
 *  call first, then cap the list at roughly 120. */
const CATALOG_INGREDIENTS_PROVIDERS = ["anthropic", "gemini", "openai"];

/** One catalog entry as the model sees it: `Butter (Burro)` when the
 *  content language has a translation recorded, plain `Butter` when it
 *  doesn't. The parenthesised half exists so the model can RECOGNIZE the
 *  row in a recipe written in that language; the rule text below tells it
 *  to echo back only the half outside the parentheses, which is what makes
 *  the echoed name land as an exact match against the catalog's base name. */
function renderCatalogEntry(entry: { name: string; translatedName: string | null }): string {
  const translated = entry.translatedName?.trim();
  if (!translated || translated.toLowerCase() === entry.name.trim().toLowerCase()) return entry.name;
  return `${entry.name} (${translated})`;
}

/** The catalog as this provider actually receives it. The tiering lives
 *  here, in one function, rather than being decided once for the prompt
 *  and again for the validation — those two answering differently is
 *  exactly the bug that would let an Ollama parse have a claim accepted
 *  against an ingredient list it was never shown. */
function catalogSentTo(catalog: ImportCatalog | null, provider: string): ImportCatalog | null {
  if (!catalog) return null;
  if (CATALOG_INGREDIENTS_PROVIDERS.includes(provider)) return catalog;
  return { ...catalog, ingredients: [] };
}

/** The library vocabulary appended to the system prompt, or '' when there
 *  is nothing to append. An empty library returning '' is deliberate: a
 *  fresh install then gets exactly the prompt it got before this feature
 *  existed, which is the cheapest regression guard available. */
export function catalogSection(catalog: ImportCatalog | null, provider: string): string {
  const sent = catalogSentTo(catalog, provider);
  if (!sent) return "";
  const lists: string[] = [];
  if (sent.ingredients.length) {
    lists.push(`Ingredienti: ${sent.ingredients.map(renderCatalogEntry).join(", ")}`);
  }
  if (sent.tools.length) {
    lists.push(`Strumenti: ${sent.tools.map(renderCatalogEntry).join(", ")}`);
  }
  if (sent.techniques.length) {
    lists.push(`Tecniche: ${sent.techniques.map(renderCatalogEntry).join(", ")}`);
  }
  if (!lists.length) return "";

  return `
Catalogo della libreria dell'utente — voci GIÀ esistenti, da riusare:
${lists.join("\n")}

Regole sul catalogo:
- Ogni voce è scritta come "NomeCatalogo (traduzione)". Il nome da usare è SEMPRE quello FUORI dalle parentesi, copiato carattere per carattere; la parte tra parentesi serve solo a farti riconoscere la voce e non va mai scritta in output
- catalogName (negli ingredienti) è il nome della voce di catalogo a cui quell'ingrediente corrisponde, copiato ESATTAMENTE dall'elenco sopra; null se nessuna voce corrisponde. Il campo name resta la dicitura della ricetta originale ("burro morbido a temperatura ambiente") e non va mai sostituito con il nome di catalogo
- tools e techniques (negli step): quando la voce esiste a catalogo scrivi ESATTAMENTE il nome di catalogo al posto della dicitura della ricetta; solo se non esiste conia un nome nuovo, breve, generico e in inglese
- Non forzare gli abbinamenti: se un ingrediente, uno strumento o una tecnica NON è nel catalogo, lascia catalogName a null (o conia un nome nuovo) invece di scegliere la voce "più vicina". "Margarina" non è "Butter", "Padella in ghisa" non è "Teglia"
- Il campo name degli ingredienti negli step va copiato dal campo name della lista principale, MAI da catalogName`;
}

/** The system prompt for one parse: the fixed rules, plus whatever the
 *  user's library already knows. */
export function buildSystemPrompt(catalog: ImportCatalog | null, provider: string): string {
  return `${SYSTEM_PROMPT_BASE}${catalogSection(catalog, provider)}`;
}

/** The set of names we actually put in the prompt, normalized the same way
 *  the fuzzy matcher normalizes (lowercase, strip diacritics and
 *  punctuation) so "Crème fraîche" and "creme fraiche" are one key. */
function catalogNameSet(catalog: ImportCatalog | null): Set<string> {
  const set = new Set<string>();
  if (!catalog) return set;
  for (const entry of catalog.ingredients) set.add(normalizeCatalogName(entry.name));
  return set;
}

function normalizeCatalogName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/** Validation, not trust.
 *
 *  A model asked to pick from a list will sometimes answer with something
 *  that was never on it — a plausible-sounding ingredient it knows about,
 *  or the recipe's own wording echoed back as though it were a catalog
 *  entry. Either one, left alone, would be auto-selected in the Review
 *  Matches step and quietly fold a distinct ingredient into an existing
 *  row. So every claim is checked against the catalog THIS request
 *  actually sent, and anything else is dropped to null, which simply puts
 *  that ingredient back on the fuzzy-matching path it took before.
 *
 *  This lives here rather than in the UI because the parse functions are
 *  the only place that holds both the catalog and the response. */
export function dropUnknownCatalogNames<
  T extends { ingredients: Array<{ name: string; catalogName?: string | null }>; warnings: string[] }
>(result: T, catalog: ImportCatalog | null, provider: string): T {
  // catalogSentTo(), not `catalog` — on a tier that withholds the
  // ingredient list, every claim the model makes about it is a guess, and
  // a guess that happens to name a real row is still a guess. Dropping it
  // puts that ingredient back on the fuzzy-matching path, which is exactly
  // where it was before this feature existed.
  const known = catalogNameSet(catalogSentTo(catalog, provider));
  const dropped: string[] = [];
  for (const ing of result.ingredients) {
    const claim = ing.catalogName?.trim();
    if (!claim) {
      ing.catalogName = null;
      continue;
    }
    if (!known.has(normalizeCatalogName(claim))) {
      dropped.push(`"${claim}" (${ing.name})`);
      ing.catalogName = null;
    }
  }
  if (dropped.length) {
    result.warnings.push(
      `Ignorate corrispondenze inventate dal modello, assenti dalla libreria: ${dropped.join(", ")}`
    );
  }
  return result;
}
// ══════════ END TWIN BLOCK: catalog prompt ══════════

/**
 * Blocca fetch verso host interni/privati: un URL da importare arriva
 * direttamente dall'utente e viene richiesto lato server, quindi senza
 * questo controllo chiunque potrebbe usare l'import ricette per far
 * interrogare al backend la propria rete interna (SSRF).
 */
export function assertSafeImportUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL non valido");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solo URL http/https sono supportati");
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "backend" || host === "db" || host === "ollama" || // hostname dei servizi Docker interni
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "::1" ||
    host.endsWith(".local");

  if (blocked) {
    throw new Error("URL non consentito (host interno/privato)");
  }

  return url;
}

/**
 * Fetcha il contenuto di una URL per il parsing
 */
/** The page as-is, for the structured-data extractor to read. Same request
 *  headers and SSRF guard as fetchUrlContent() below, but without the
 *  tag-stripping and the 6 000-character truncation — schema.org JSON-LD is
 *  frequently past that cutoff, which is one of the reasons the LLM path
 *  used to lose it. Capped at 4 MB so a hostile or broken URL can't stream
 *  unbounded into memory. */
export async function fetchUrlHtml(url: string): Promise<string> {
  const parsed = assertSafeImportUrl(url);
  const response = await fetch(url, {
    headers: isCaptionOnlyHost(parsed) ? CRAWLER_FETCH_HEADERS : IMPORT_FETCH_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const html = await response.text();
  return html.length > 4_000_000 ? html.slice(0, 4_000_000) : html;
}

// ── Caption-only hosts (Instagram) ────────────────────────────────
// Mirrors frontend/src/services/pageFetcher.ts's block of the same name —
// keep the two in step. Instagram answers a browser User-Agent with a
// ~650KB JavaScript shell whose entire visible text is the word
// "Instagram", so fetchUrlContent()'s tag-stripping used to hand the model
// nothing at all for an imported reel. The post's text is published only to
// a crawler-shaped request, and only <meta name="description"> carries the
// WHOLE caption — og:description is truncated mid-word, losing the
// ingredients.
const CAPTION_ONLY_HOSTS = [/(?:^|\.)instagram\.com$/i];

function isCaptionOnlyHost(url: URL): boolean {
  return CAPTION_ONLY_HOSTS.some((re) => re.test(url.hostname));
}

const CRAWLER_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

/** Entity decode that PRESERVES newlines — a caption's line breaks are the
 *  structure the model reads its ingredient list from. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&"); // last, or it would mangle the entities above
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*\scontent=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*\s${attr}=["']${key}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}

/** The cover image a page nominates for itself. og:image is the picture the
 *  site publishes for link previews, so it is the dish rather than a logo,
 *  and it needs no guessing about which of forty <img> tags is the recipe.
 *  Mirrors frontend/src/services/pageFetcher.ts's extractPageImage(). */
function extractPageImage(rawUrl: string, html: string): string | null {
  const raw =
    metaContent(html, "property", "og:image") ??
    metaContent(html, "property", "og:image:url") ??
    metaContent(html, "name", "twitter:image");
  if (!raw) return null;
  return absoluteImageUrl(decodeEntities(raw).trim(), rawUrl);
}

/** Resolves a possibly-relative image URL against its page and rejects
 *  anything that is not a real remote image — `data:` blobs included, since
 *  a cover is stored as a URL string. */
export function absoluteImageUrl(candidate: string | null | undefined, baseUrl?: string): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const resolved = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** The post's caption for a caption-only host; null for every ordinary
 *  site, where a <meta name="description"> is just a 160-char SEO blurb and
 *  preferring it over the page body would break working imports. */
function extractSocialCaption(rawUrl: string, html: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isCaptionOnlyHost(url)) return null;

  const raw = metaContent(html, "name", "description") ?? metaContent(html, "property", "og:description");
  if (!raw) return null;

  let caption = decodeEntities(raw).trim();
  // `13K likes, 118 comments - someone on June 7, 2023: "<caption>". `
  const framed = caption.match(/^[\d.,KMkm]+\s+likes?,\s*[\d.,KMkm]+\s+comments?\s+-\s+[^:]+:\s*"([\s\S]*)"\.?\s*$/);
  if (framed) caption = framed[1].trim();

  return caption || null;
}

const IMPORT_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

/** The page's text for the model, plus the cover image the page nominates.
 *  Returned together because both come from the SAME fetch — asking for the
 *  image separately would mean requesting the page twice. */
async function fetchUrlContent(url: string): Promise<{ text: string; imageUrl: string | null }> {
  const parsedUrl = assertSafeImportUrl(url);
  // Aggiungiamo header più completi per bypassare firewall basici
  const response = await fetch(url, {
    // A caption host ignores all of this and needs an unfurler-shaped
    // request instead — see CAPTION_ONLY_HOSTS above.
    headers: isCaptionOnlyHost(parsedUrl) ? CRAWLER_FETCH_HEADERS : {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
    signal: AbortSignal.timeout(15_000),
  });
  
  if (!response.ok) {
    console.error(`[LLM Parser] Errore fetch ${url}: ${response.status} ${response.statusText}`);
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  
  const html = await response.text();

  // A caption host publishes the post text as page metadata; its page body
  // is an empty JS shell, so stripping tags off it would return nothing.
  const caption = extractSocialCaption(url, html);
  const imageUrl = extractPageImage(url, html);
  if (caption) return { text: caption.slice(0, 6000), imageUrl };

  // Rimuovi tag HTML per semplificare il testo
  const text = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
             .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim()
             .slice(0, 6000); // ridotto da 10000: meno prefill su CPU-only inference, il contenuto della ricetta è quasi sempre entro questa soglia
  return { text, imageUrl };
}

// ── Media ──────────────────────────────────────────────────────────────────
// Mirrors frontend/src/services/llmParser.local.ts's own block. Kept in
// step with it deliberately rather than shared: standalone mode has no
// backend to import from, and this is the half of the two files that MUST
// agree, because a user moving a library between the two modes expects the
// same file to import the same way.

export type MediaKind = "image" | "audio" | "video" | "document";

/** Thrown when the attached file is something the configured provider
 *  cannot read, or is too big to send. Distinguished from every other
 *  parse failure so the route can answer 400 rather than 502: the request
 *  is the problem and the user can fix it (switch provider, trim the file),
 *  which a "bad gateway" actively hides. */
export class MediaNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaNotSupportedError";
  }
}

/** What kind of thing a MIME type is, as far as the providers care. PDFs
 *  are their own kind because they are the one format a model reads as a
 *  *document* (page structure, embedded text) rather than as pixels. */
export function mediaKindFor(mimeType: string): MediaKind | null {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/** Which provider can read which kind, as of the models pinned in
 *  llm.providers.ts.
 *
 *  A table rather than try-and-see: every one of these rejections comes
 *  back as an HTTP 400 about a malformed content block, which tells the
 *  user nothing about the real problem (their provider cannot do audio) or
 *  the real fix (switch to one that can). Gemini is the only one of the
 *  four that takes audio and video at all, which is worth saying out loud
 *  rather than making someone discover.
 *
 *  Ollama's entry means "images, if the model has eyes": the API accepts an
 *  `images` array against any model and a text-only one simply ignores it,
 *  so a wrong local model shows up as a recipe hallucinated out of nothing
 *  rather than as an error. That cannot be caught here — hence the mention
 *  in the error text and in the import screen. */
const MEDIA_SUPPORT: Record<string, MediaKind[]> = {
  anthropic: ["image", "document"],
  gemini: ["image", "document", "audio", "video"],
  openai: ["image"],
  ollama: ["image"],
};

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI",
  ollama: "Ollama",
};

const KIND_LABEL: Record<MediaKind, string> = {
  image: "images",
  document: "PDFs",
  audio: "audio",
  video: "video",
};

/** Base64 inflates by ~4/3, and every provider has a request ceiling in the
 *  tens of megabytes for an inline payload. Checked before the upload goes
 *  anywhere, because the failure otherwise arrives minutes into pushing a
 *  video across. Kept in step with the route's own body-size limit — see
 *  POST /recipes/parse in routes/recipes.ts. */
const MAX_MEDIA_BYTES = 18 * 1024 * 1024;

export function providersSupporting(kind: MediaKind): string[] {
  return Object.keys(MEDIA_SUPPORT).filter((p) => MEDIA_SUPPORT[p].includes(kind));
}

function assertMediaSupported(provider: string, media: LLMParseMedia): void {
  const kind = mediaKindFor(media.mimeType);
  if (!kind) {
    throw new MediaNotSupportedError(
      `SmartChef doesn't know what to do with a ${media.mimeType || "file of that type"} — use an image, a PDF, an audio file or a video.`
    );
  }
  const supported = MEDIA_SUPPORT[provider] ?? [];
  if (!supported.includes(kind)) {
    const alternatives = providersSupporting(kind).map((p) => PROVIDER_LABEL[p] ?? p);
    throw new MediaNotSupportedError(
      `${PROVIDER_LABEL[provider] ?? provider} can't read ${KIND_LABEL[kind]}. ` +
        (alternatives.length
          ? `Switch to ${alternatives.join(" or ")} in Account settings, or extract the text yourself and paste it in.`
          : "Extract the text yourself and paste it in instead.")
    );
  }
  // Approximate: 4 base64 characters carry 3 bytes.
  const bytes = Math.floor((media.data.length * 3) / 4);
  if (bytes > MAX_MEDIA_BYTES) {
    throw new MediaNotSupportedError(
      `That file is about ${Math.round(bytes / 1024 / 1024)} MB — too large to send in one request. Trim the clip, or use a smaller photo.`
    );
  }
}

/**
 * Chiama Ollama con un system prompt arbitrario — usato sia per il parsing
 * ricette (SYSTEM_PROMPT_BASE) sia per la traduzione contenuti ricetta.
 */
async function callOllama(
  content: string,
  systemPrompt: string,
  ollamaUrl: string = OLLAMA_URL,
  media?: LLMParseMedia
): Promise<string> {
  // Ollama attaches images as a base64 array on the message itself. It
  // accepts this against ANY model: a text-only one silently drops the
  // image and answers from the prompt alone, which is why the capability
  // table's error text talks about needing a vision model rather than
  // assuming the right request shape is enough.
  const userMessage: Record<string, unknown> = { role: "user", content };
  if (media) userMessage.images = [media.data];
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        userMessage,
      ],
      options: {
        temperature: 0.1, // bassa temperatura per output strutturato
        // Misurato ~4.4 tok/s su questa CPU (nessuna GPU) con il contenuto
        // ridotto a 6000 caratteri. 900 token ha troncato una ricetta con
        // molti ingredienti; alzato a 1500 (~340s di generazione, entro il
        // timeout sotto) — repairTruncatedJson() sopra fa comunque da rete
        // di sicurezza se anche questo non bastasse.
        num_predict: 1500,
      },
    }),
    signal: AbortSignal.timeout(600_000), // 10 min: margine ampio sopra il caso peggiore osservato
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content ?? "";
}

interface LLMAccountConfig {
  llm_provider: string;
  anthropic_api_key_encrypted: string | null;
  gemini_api_key_encrypted: string | null;
  openai_api_key_encrypted: string | null;
  ollama_url: string | null;
}

/**
 * Dispatches to whichever LLM provider the account has configured
 * (account.llm_provider — 'ollama' by default, never auto-switched to a
 * cloud provider just because a key exists). Throws immediately if a
 * cloud provider is selected but has no key saved, rather than silently
 * falling back to Ollama — the error propagates through the caller's own
 * error handling unchanged. Generic over systemPrompt/content so it's
 * reusable for both recipe parsing and recipe-content translation.
 */
/** Which provider a parse will actually use, read before the call so the
 *  prompt can be tiered for it (see CATALOG_INGREDIENTS_PROVIDERS). One
 *  extra `LIMIT 1` against `account` per parse, which is nothing next to
 *  the model call that follows. */
export async function getConfiguredProvider(): Promise<string> {
  const account = await queryOne<{ llm_provider: string }>(
    `SELECT llm_provider FROM account LIMIT 1`
  );
  return account?.llm_provider ?? "ollama";
}

export async function callConfiguredProvider(
  content: string,
  systemPrompt: string,
  media?: LLMParseMedia
): Promise<string> {
  const account = await queryOne<LLMAccountConfig>(
    `SELECT llm_provider, anthropic_api_key_encrypted, gemini_api_key_encrypted, openai_api_key_encrypted, ollama_url FROM account LIMIT 1`
  );
  const provider = account?.llm_provider ?? "ollama";
  // Checked before the key checks below on purpose: "Gemini can't read
  // video" is the more useful sentence than "no key saved" when both are
  // true, since pasting a key would not have helped.
  if (media) assertMediaSupported(provider, media);

  if (provider === "anthropic") {
    if (!account?.anthropic_api_key_encrypted) {
      throw new Error("Anthropic selected but no API key configured — add one in Account settings");
    }
    return callAnthropic(content, decrypt(account.anthropic_api_key_encrypted), systemPrompt, media);
  }
  if (provider === "gemini") {
    if (!account?.gemini_api_key_encrypted) {
      throw new Error("Gemini selected but no API key configured — add one in Account settings");
    }
    return callGemini(content, decrypt(account.gemini_api_key_encrypted), systemPrompt, media);
  }
  if (provider === "openai") {
    if (!account?.openai_api_key_encrypted) {
      throw new Error("OpenAI selected but no API key configured — add one in Account settings");
    }
    return callOpenAI(content, decrypt(account.openai_api_key_encrypted), systemPrompt, media);
  }
  return callOllama(content, systemPrompt, resolveOllamaUrl(account?.ollama_url), media);
}

/**
 * L'output del modello può venire troncato se raggiunge il limite di
 * num_predict a metà di un array/oggetto (frequente su CPU-only inference
 * dove teniamo il budget di token basso per limitare la latenza). Ripara
 * il JSON troncato: individua l'ultimo punto "sicuro" per tagliare (subito
 * dopo una virgola o parentesi di apertura, fuori da una stringa) e chiude
 * le parentesi rimaste aperte nell'ordine corretto, scartando l'elemento
 * parziale finale piuttosto che perdere l'intera risposta.
 */
function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafeIndex = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); lastSafeIndex = i; }
    else if (ch === "}" && stack[stack.length - 1] === "{") stack.pop();
    else if (ch === "]" && stack[stack.length - 1] === "[") stack.pop();
    else if (ch === "," && !inString) lastSafeIndex = i;
  }

  if (lastSafeIndex === -1) return raw;

  // Ricalcola lo stack di parentesi aperte fino al punto di taglio, poi chiudile in ordine inverso.
  let truncated = raw.slice(0, lastSafeIndex + 1);
  if (truncated.trimEnd().endsWith(",")) truncated = truncated.trimEnd().slice(0, -1);

  const reStack: string[] = [];
  inString = false;
  escape = false;
  for (const ch of truncated) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") reStack.push(ch);
    else if (ch === "}" && reStack[reStack.length - 1] === "{") reStack.pop();
    else if (ch === "]" && reStack[reStack.length - 1] === "[") reStack.pop();
  }
  if (inString) truncated += '"';
  for (let i = reStack.length - 1; i >= 0; i--) {
    truncated += reStack[i] === "{" ? "}" : "]";
  }
  return truncated;
}

/**
 * Parsa la risposta JSON dell'LLM con fallback
 */
function parseJsonResponse(raw: string, baseUrl?: string): LLMParseResult {
  // Cerca il JSON nella risposta (l'LLM potrebbe aggiungere testo)
  const jsonMatch = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*/);
  if (!jsonMatch) throw new Error("Nessun JSON valido nella risposta LLM");

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = JSON.parse(repairTruncatedJson(jsonMatch[0]));
  }

  // Validazione base e normalizzazione
  return {
    title: parsed.title ?? "Ricetta senza titolo",
    language: typeof parsed.language === "string" && /^[a-z]{2}$/i.test(parsed.language.trim())
      ? parsed.language.trim().toLowerCase()
      : undefined,
    description: parsed.description ?? undefined,
    servings: typeof parsed.servings === "number" ? parsed.servings : undefined,
    prepTimeMin: typeof parsed.prepTimeMin === "number" ? parsed.prepTimeMin : undefined,
    cookTimeMin: typeof parsed.cookTimeMin === "number" ? parsed.cookTimeMin : undefined,
    restTimeMin: typeof parsed.restTimeMin === "number" ? parsed.restTimeMin : undefined,
    difficulty: ["easy", "medium", "hard", "expert"].includes(parsed.difficulty)
      ? parsed.difficulty
      : "medium",
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === "string") : [],
    storageInstructions: typeof parsed.storageInstructions === "string" ? parsed.storageInstructions : null,
    tips: typeof parsed.tips === "string" ? parsed.tips : null,
    ingredients: Array.isArray(parsed.ingredients)
      ? parsed.ingredients.map((ing: any, i: number) => ({
          name: ing.name ?? `Ingrediente ${i + 1}`,
          // The library entry the model claims this corresponds to.
          // Trusted no further than this: dropUnknownCatalogNames() checks
          // it against the catalog actually sent before anything acts on it.
          catalogName:
            typeof ing.catalogName === "string" && ing.catalogName.trim() ? ing.catalogName.trim() : null,
          quantity: typeof ing.quantity === "number" ? ing.quantity : undefined,
          quantityText: ing.quantityText ?? undefined,
          unit: ing.unit ?? undefined,
          notes: ing.notes ?? undefined,
          groupName: typeof ing.groupName === "string" ? ing.groupName : null,
          isOptional: ing.isOptional === true,
        }))
      : [],
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((step: any, i: number) => ({
          stepNumber: step.stepNumber ?? i + 1,
          title: step.title ?? undefined,
          description: step.description ?? "",
          durationMin: typeof step.durationMin === "number" ? step.durationMin : undefined,
          techniques: Array.isArray(step.techniques) ? step.techniques.filter((t: unknown) => typeof t === "string") : [],
          // Which of the recipe's ingredients this step uses. Kept as the
          // model's own names and resolved against the ingredient list by
          // the client (lib/stepRefs.ts's matchStepIngredients) rather than
          // trusting an array index, which is what a model gets wrong.
          ingredients: Array.isArray(step.ingredients)
            ? step.ingredients
                .filter((u: any) => u && typeof u.name === "string")
                .map((u: any) => ({
                  name: u.name as string,
                  quantity: typeof u.quantity === "number" ? u.quantity : null,
                  unit: typeof u.unit === "string" ? u.unit : null,
                }))
            : [],
        }))
      : [],
    sourceUrl: undefined,
    // Resolved and validated rather than trusted: a model will happily
    // return a relative path, a `data:` blob or a plausible URL it invented.
    // The caller falls back to the page's own og:image when this is empty.
    imageUrl: absoluteImageUrl(typeof parsed.imageUrl === "string" ? parsed.imageUrl : null, baseUrl) ?? undefined,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

/** What to tell the model about a file it is being handed. The prompt
 *  itself stays SYSTEM_PROMPT_BASE — this only names the medium, so the model
 *  treats a transcript-shaped input as a recipe being dictated rather than
 *  as prose to summarize. Italian, like the system prompt, and for the same
 *  reason: the two are read together, and the unit-normalization rule is
 *  written against Italian. Kept identical to the standalone twin's. */
const MEDIA_INSTRUCTION: Record<MediaKind, string> = {
  image:
    "Estrai la ricetta dall'immagine allegata (una foto, una scansione o uno screenshot di una pagina di ricetta). Leggi tutto il testo visibile, comprese le liste di ingredienti e i passaggi.",
  document: "Estrai la ricetta dal documento allegato.",
  audio:
    "Ascolta l'audio allegato: è qualcuno che racconta o detta una ricetta. Trascrivila mentalmente e restituisci la ricetta strutturata. Gli ingredienti e le quantità possono essere detti in modo informale (\"un paio di cucchiai\") — in quel caso usa quantityText.",
  video:
    "Guarda il video allegato: è una preparazione di cucina. Usa sia il parlato sia ciò che si vede (ingredienti inquadrati, testo sovrimpresso) per ricostruire la ricetta. Se una quantità non viene mai detta né mostrata, lascia quantity a null invece di inventarla.",
};

/**
 * Entry point principale del parser LLM
 */
export async function parseRecipeWithLLM(req: LLMParseRequest): Promise<LLMParseResult> {
  // Loaded once per parse and reused by both branches below: the prompt
  // tells the model which ingredients/tools/techniques this library
  // already knows, and dropUnknownCatalogNames() then checks its answers
  // against the very same list.
  const provider = await getConfiguredProvider();
  const catalog: ImportCatalog | null = await loadImportCatalog(req.lang).catch((err) => {
    // A catalog that fails to load must not take the import down with it —
    // without one the parse behaves exactly as it did before this existed.
    console.warn("Import catalog unavailable, parsing without it:", err);
    return null;
  });
  const systemPrompt = buildSystemPrompt(catalog, provider);
  // A file goes up alongside the prompt rather than being flattened to text
  // first. The client's own OCR (frontend/src/services/migration/ocr.ts) is
  // still the right tool for a clean scan of printed text — free, offline,
  // exact — but it has nothing to say about a voice note or a clip, and it
  // throws away the layout that tells a model which column is the
  // ingredient list.
  if (req.inputType === "media") {
    if (!req.media?.data) throw new MediaNotSupportedError("No file was attached.");
    const kind = mediaKindFor(req.media.mimeType);
    if (!kind) {
      throw new MediaNotSupportedError(
        `SmartChef doesn't know what to do with a ${req.media.mimeType || "file of that type"}.`
      );
    }
    const extra = req.input.trim();
    const prompt = `${MEDIA_INSTRUCTION[kind]}${extra ? `

Note aggiuntive dall'utente:
${extra}` : ""}`;
    return dropUnknownCatalogNames(
      parseJsonResponse(await callConfiguredProvider(prompt, systemPrompt, req.media)),
      catalog,
      provider
    );
  }

  let content: string;
  // The cover image the page nominates for itself. The model only ever sees
  // STRIPPED text, so without handing it one it has no way to find an image
  // at all — which is why AI import produced recipes with no cover while
  // the structured-data path always set one.
  let pageImage: string | null = null;

  if (req.inputType === "url") {
    const fetched = await fetchUrlContent(req.input);
    content = fetched.text;
    pageImage = fetched.imageUrl;
    // Offered rather than forced: the model can reject it (a logo, a
    // category banner) or name a better URL from the text. Appended after
    // the 6 000-character cut so a long page cannot truncate it away.
    if (pageImage) {
      content += `\n\nImmagine di copertina della pagina: ${pageImage}`;
    }
  } else {
    content = req.input;
  }

  const rawResponse = await callConfiguredProvider(`Analizza questa ricetta:\n\n${content}`, systemPrompt);
  const result = dropUnknownCatalogNames(
    parseJsonResponse(rawResponse, req.inputType === "url" ? req.input : undefined),
    catalog,
    provider
  );

  if (req.inputType === "url") {
    result.sourceUrl = req.input;
    // Fallback, not override: a model that found a better image keeps it.
    if (!result.imageUrl && pageImage) result.imageUrl = pageImage;
  }

  return result;
}

/**
 * Traduce un elenco di nomi ingredienti da una lingua all'altra in un'unica
 * chiamata batch (usato per mantenere il nome-base degli ingredienti in
 * inglese anche quando vengono creati automaticamente durante l'import di
 * una ricetta in un'altra lingua — vedi ingredient.matcher.ts). Ritorna
 * una mappa nome-originale -> nome-tradotto; in caso di risposta malformata
 * o parziale, i nomi mancanti sono semplicemente assenti dalla mappa e il
 * chiamante ricade sul comportamento esistente (nome originale invariato).
 */
export async function translateIngredientNames(
  names: string[],
  fromLang: string,
  toLang: string
): Promise<Record<string, string>> {
  if (names.length === 0) return {};

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: `Traduci nomi di ingredienti da culinaria dalla lingua "${fromLang}" alla lingua "${toLang}". ` +
            `Rispondi ESCLUSIVAMENTE con un oggetto JSON che mappa ogni nome originale al suo nome tradotto, ` +
            `senza testo aggiuntivo. Esempio: {"Cipolla": "Onion"}. Mantieni la capitalizzazione naturale della lingua di destinazione.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      options: { temperature: 0.1, num_predict: 500 },
    }),
    // Measured too tight at 60s for a 25-name batch on CPU-only inference —
    // generous margin like the other Ollama calls in this file.
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) throw new Error(`Ollama error ${response.status}`);

  const data = await response.json() as { message?: { content?: string } };
  const raw = data.message?.content ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result: Record<string, string> = {};
    for (const name of names) {
      if (typeof parsed[name] === "string" && parsed[name].trim()) {
        result[name] = parsed[name].trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Translates a batch of UI strings (button labels, headings, placeholders —
 * short, imperative, standalone) from English into another language in one
 * call. Same shape as translateIngredientNames above but with a prompt
 * tuned for app-chrome text rather than culinary terms, and a larger safe
 * batch size since these strings are shorter. Local small-model translation,
 * not human-reviewed — spot-check the result the same way the ingredient
 * backfill was checked.
 */
export async function translateUiStrings(
  strings: string[],
  toLang: string
): Promise<Record<string, string>> {
  if (strings.length === 0) return {};

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: `Translate the following user-interface strings from a recipe-management web app ` +
            `from English into "${toLang}" (ISO 639-1 code). These are short UI labels, buttons, ` +
            `headings and placeholders, not prose — keep translations equally short and natural for ` +
            `a cooking app's UI, preserving punctuation like "…" or ":" where present. Some strings ` +
            `contain placeholders wrapped in double curly braces, e.g. "{{count}}" or "{{title}}" — ` +
            `copy these tokens through EXACTLY as-is, unchanged and untranslated, in the same relative ` +
            `position in the sentence; never translate or alter the text inside the braces. Respond ` +
            `EXCLUSIVELY with a JSON object mapping each original string to its translation, no extra ` +
            `text. Example: {"Save": "Salvar", "{{count}} recipes": "{{count}} recetas"}.`,
        },
        { role: "user", content: JSON.stringify(strings) },
      ],
      options: { temperature: 0.1, num_predict: 1500 },
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) throw new Error(`Ollama error ${response.status}`);

  const data = await response.json() as { message?: { content?: string } };
  const raw = data.message?.content ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result: Record<string, string> = {};
    for (const s of strings) {
      if (typeof parsed[s] === "string" && parsed[s].trim()) {
        result[s] = parsed[s].trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export interface RecipeTranslationStep {
  id: string;
  title: string | null;
  description: string;
  notes: string | null;
}
export interface RecipeTranslationIngredientNote {
  id: string;
  notes: string;
}
export interface RecipeTranslationInput {
  title: string;
  description: string | null;
  steps: RecipeTranslationStep[];
  ingredientNotes: RecipeTranslationIngredientNote[];
}
export type RecipeTranslationOutput = RecipeTranslationInput;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", it: "Italian", fr: "French", es: "Spanish" };

/**
 * Translates a recipe's title/description/step content/ingredient notes
 * into a target language in one call, using whichever LLM provider the
 * account has configured (see callConfiguredProvider). The `id` fields are
 * opaque identifiers the model must copy through unchanged — they're how
 * the caller maps translated steps/ingredient notes back to the right DB
 * rows — never translated content themselves.
 */
export async function translateRecipeContent(
  input: RecipeTranslationInput,
  targetLang: string
): Promise<RecipeTranslationOutput> {
  const targetLangName = LANGUAGE_NAMES[targetLang] ?? targetLang;
  const systemPrompt =
    `You translate recipe content from a recipe-management app into ${targetLangName} (ISO code "${targetLang}"). ` +
    `You will receive a JSON object with a title, an optional description, a list of steps (each with an id, ` +
    `optional title, description, and optional notes — "notes" is a chef's tip for that step), and a list of ` +
    `ingredient notes (each with an id and short free-text note, e.g. "finely chopped"). ` +
    `Translate every text field naturally and idiomatically into ${targetLangName}, preserving culinary meaning ` +
    `and quantities/units exactly as written. The "id" fields are opaque identifiers — copy them through EXACTLY ` +
    `unchanged, never translate or alter them. If a field is null in the input, keep it null in the output. ` +
    `Respond EXCLUSIVELY with a JSON object matching the exact same shape as the input ` +
    `({title, description, steps: [{id, title, description, notes}], ingredientNotes: [{id, notes}]}), no extra text.`;

  const raw = await callConfiguredProvider(JSON.stringify(input), systemPrompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Translation response contained no JSON");

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = JSON.parse(repairTruncatedJson(jsonMatch[0]));
  }

  const stepById = new Map(input.steps.map((s) => [s.id, s]));
  const noteById = new Map(input.ingredientNotes.map((n) => [n.id, n]));

  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : input.title,
    description: typeof parsed.description === "string" ? parsed.description : null,
    steps: Array.isArray(parsed.steps)
      ? parsed.steps
          .filter((s: any) => s && typeof s.id === "string" && stepById.has(s.id))
          .map((s: any) => ({
            id: s.id,
            title: typeof s.title === "string" ? s.title : null,
            description: typeof s.description === "string" && s.description.trim() ? s.description : stepById.get(s.id)!.description,
            notes: typeof s.notes === "string" ? s.notes : null,
          }))
      : [],
    ingredientNotes: Array.isArray(parsed.ingredientNotes)
      ? parsed.ingredientNotes
          .filter((n: any) => n && typeof n.id === "string" && typeof n.notes === "string" && n.notes.trim() && noteById.has(n.id))
          .map((n: any) => ({ id: n.id, notes: n.notes }))
      : [],
  };
}

/**
 * Verifica che Ollama sia raggiungibile
 */
export async function checkOllamaHealth(ollamaUrl: string = OLLAMA_URL): Promise<{ ok: boolean; models: string[] }> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}
