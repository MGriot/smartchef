// ════════════════════════════════════════════════════════════════════════
// SmartChef — Smart Import's LLM parsing, standalone mode
//
// Server mode's POST /api/recipes/parse runs backend/src/services/
// llm.parser.ts. Standalone mode has no backend, so this is that same
// pipeline done on the device: fetch the page (if the input is a URL),
// send it to whichever provider lib/llmSettings.ts has configured, and
// normalize the model's JSON into the same parsed-recipe shape the
// server route returns.
//
// Deliberately mirrors the backend file rather than sharing code with it:
// the two runtimes differ in every mechanical detail (no usable fetch()
// from the renderer — see lib/nativeHttp.ts — no env vars, no encrypted
// key columns) while the parts that MUST NOT drift are the prompt and the
// response normalization, which are copied verbatim below. Changing the
// extraction contract means changing it in both places; that is the same
// arrangement pageFetcher.ts and localMatcher.ts already have with their
// own backend counterparts.
//
// Multimodal input (a photo of a page, a voice note, a cooking video) goes
// through the same prompt and the same normalization as text — only the
// user turn changes shape, and only per provider. What differs is which
// provider can take what: see MEDIA_SUPPORT below, which is enforced up
// front so an unsupported combination fails with a sentence naming a
// provider that would work rather than with the provider's own raw 400.
// ════════════════════════════════════════════════════════════════════════

// shared/types (where the backend's LLMParseResult lives) is not wired
// into the frontend build — see the note in lib/fuzzyMatch.ts. The
// frontend's own TemplateParseResult is the same shape by design: it is
// what RecipeImport.tsx already casts the /api/recipes/parse response to,
// so returning it here type-checks the wire contract instead of asserting
// it.
import type { TemplateParseResult } from './recipeTemplateParser';
import { getLlmSettings, DEFAULT_OLLAMA_URL, type LlmProvider } from '../lib/llmSettings';
import { checkMediaForProvider, mediaKindFor, type MediaKind } from '../lib/llmMedia';
import { nativeHttpPostJson } from '../lib/nativeHttp';
import { fetchPageHtml, extractSocialCaption, extractPageImage, absoluteImageUrl } from './pageFetcher';

// ── Model choices ───────────────────────────────────────────────────────
// The same cheap/fast tier each provider's backend default picks
// (llm.providers.ts). Recipe parsing is structured extraction, not
// frontier reasoning, and unlike the backend these are per-user spend the
// moment someone pastes a key — so the default matters.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// gemini-2.0-flash was retired mid-2026 and now answers HTTP 404 with
// "no longer available ... use models/gemini-3.6-flash" — Google's own
// response names the successor, which is where this value comes from.
// Worth knowing that a retired model is a HARD failure of Smart Import in
// a shipped desktop installer, with no env var to work around it the way
// the backend has (llm.providers.ts reads GEMINI_MODEL) — so if this
// recurs, the durable fix is an optional per-provider model field in
// lib/llmSettings.ts rather than another constant bump.
const GEMINI_MODEL = 'gemini-3.6-flash';
const OPENAI_MODEL = 'gpt-4o-mini';
const OLLAMA_MODEL = 'llama3.1:8b';

/** Cloud APIs answer in seconds. */
const CLOUD_TIMEOUT_MS = 60_000;
/** CPU-only local inference does not — the backend allows 600s for the
 *  same call, and RecipeImport.tsx's own apiFetch ceiling is 650s. */
const OLLAMA_TIMEOUT_MS = 600_000;

// ── The extraction contract ─────────────────────────────────────────────
// Copied verbatim from backend/src/services/llm.parser.ts's SYSTEM_PROMPT.
// It is written in Italian there and stays that way here: the output field
// names are English but the instructions and the unit-normalization rule
// ("Normalizza le unità in italiano") are what the existing catalogs and
// localMatcher.ts expect to match against, so translating this prompt
// would quietly change what a parsed recipe looks like.
const SYSTEM_PROMPT = `Sei un assistente specializzato nell'analisi di ricette culinarie.
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
      "techniques": ["string"]
    }
  ],
  "imageUrl": "string | null (URL assoluto http/https dell'immagine di copertina del piatto, se una compare nel contenuto; altrimenti null)",
  "confidence": "number (0-1)",
  "warnings": ["string"]
}

Regole:
- restTimeMin è il tempo di attesa/riposo (lievitazione, marinatura, raffreddamento) separato dal tempo di preparazione attiva
- tools è l'elenco degli strumenti/attrezzi da cucina menzionati o chiaramente necessari (es. "forno", "planetaria", "frullatore"), nomi brevi e generici
- storageInstructions è come conservare gli avanzi ("Come conservare"), tips sono consigli generali distinti dalla description — entrambi null se non menzionati
- groupName (negli ingredienti) è un'intestazione breve e opzionale sotto cui questo ingrediente è raggruppato, es. "Per il condimento" — impostalo SOLO quando la ricetta originale raggruppa visivamente gli ingredienti in sezioni etichettate; altrimenti lascialo null. Non inventare raggruppamenti assenti nella fonte
- isOptional (negli ingredienti) è true quando la ricetta presenta quell'ingrediente come facoltativo o a piacere (es. "facoltativo", "se gradito", "optional", "per guarnire", "q.b. a piacere"); altrimenti false. Non dedurlo dal fatto che una quantità sia vaga
- techniques (negli step) è l'elenco delle tecniche di cottura riconosciute in quello step (es. "Rosolare", "Brasare"), nomi brevi, stesso criterio di "tools"
- Se una quantità è vaga (es. "q.b.", "a piacere"), metti null in quantity e il testo in quantityText
- Normalizza le unità in italiano (grammi, ml, cucchiai, ecc.)
- Stima la difficoltà basandoti sul numero di step e tecniche usate
- Se non riesci a estrarre un campo, usa null
- Aggiungi warnings per informazioni ambigue o mancanti
- imageUrl: usa SOLO un URL che compare letteralmente nel contenuto (incluso quello proposto come "Immagine di copertina della pagina"), mai inventato. Deve mostrare il piatto finito: scarta loghi, avatar, banner pubblicitari e icone. null se non ce n'è uno adatto
- confidence deve riflettere quanto sei sicuro dell'estrazione (1.0 = perfetto)`;

// ── Media ──────────────────────────────────────────────────────────────────

/** One non-text input: a photo, a scan, a PDF, a voice note, a clip.
 *  `data` is raw base64 with no `data:` prefix — every provider below
 *  wants it that way except OpenAI, which is handed a data URI built from
 *  these two fields. */
export interface ParseMedia {
  mimeType: string;
  data: string;
  /** Only used in messages, so the user can tell which file failed. */
  fileName?: string;
}

/** The capability table lives in lib/llmMedia.ts because the import screen
 *  needs it too — to say "Ollama can't read video" before a 15 MB upload
 *  rather than after. This file is the half that enforces it. */
function assertMediaSupported(provider: LlmProvider, media: ParseMedia): MediaKind {
  const kind = mediaKindFor(media.mimeType);
  if (!kind) {
    throw new Error(`SmartChef doesn't know what to do with a ${media.mimeType || 'file of that type'} — use an image, a PDF, an audio file or a video.`);
  }
  // Approximate: 4 base64 characters carry 3 bytes.
  const bytes = Math.floor((media.data.length * 3) / 4);
  const check = checkMediaForProvider(media.mimeType, bytes, provider);
  if (!check.ok) throw new Error(check.reason);
  return kind;
}

// ── Providers ───────────────────────────────────────────────────────────
// Each mirrors its llm.providers.ts counterpart, with two differences that
// come from running on the device rather than a server: the request goes
// through the native HTTP bridge (no CORS, arbitrary headers), and a
// failure quotes the provider's own response body — that text is usually
// the only thing that explains a rejected key or an exhausted quota, and
// there is no server log here for the user to go read instead.

function providerError(name: string, statusCode: number, text: string): Error {
  const detail = text.trim().slice(0, 400);
  return new Error(`${name} returned HTTP ${statusCode}${detail ? `: ${detail}` : ''}`);
}

async function callAnthropic(content: string, apiKey: string, media?: ParseMedia): Promise<string> {
  // A media turn is content BLOCKS rather than a bare string; the image or
  // document goes first so the text that follows reads as an instruction
  // about it, which is what Anthropic's own guidance asks for.
  const userContent = media
    ? [
        mediaKindFor(media.mimeType) === 'document'
          ? { type: 'document', source: { type: 'base64', media_type: media.mimeType, data: media.data } }
          : { type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.data } },
        { type: 'text', text: content },
      ]
    : content;
  const { statusCode, text, json } = await nativeHttpPostJson(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      // No temperature/top_p/top_k — current Claude models return HTTP 400
      // on any non-default sampling param.
    },
    CLOUD_TIMEOUT_MS,
  );
  if (statusCode < 200 || statusCode >= 300) throw providerError('Anthropic', statusCode, text);
  const data = json as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  if (data?.stop_reason === 'refusal') throw new Error('Anthropic declined the request (safety classifier)');
  return data?.content?.find((b) => b.type === 'text')?.text ?? '';
}

async function callGemini(content: string, apiKey: string, media?: ParseMedia): Promise<string> {
  // inlineData covers images, PDFs, audio AND video with one shape — the
  // reason Gemini is the fallback this file steers people to for a voice
  // note or a clip.
  const parts: Array<Record<string, unknown>> = media
    ? [{ inlineData: { mimeType: media.mimeType, data: media.data } }, { text: content }]
    : [{ text: content }];
  const { statusCode, text, json } = await nativeHttpPostJson(
    // The key travels in a header, not the `?key=` query parameter the
    // backend uses. Same API either way, but a URL query string is the one
    // place a credential reliably ends up in logs it should not be in.
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { 'x-goog-api-key': apiKey },
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
    },
    CLOUD_TIMEOUT_MS,
  );
  if (statusCode < 200 || statusCode >= 300) throw providerError('Gemini', statusCode, text);
  const data = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOpenAI(content: string, apiKey: string, media?: ParseMedia): Promise<string> {
  // OpenAI takes an image as a data URI in an image_url part rather than as
  // raw base64 — the one provider here that does.
  const userContent = media
    ? [
        { type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.data}` } },
        { type: 'text', text: content },
      ]
    : content;
  const { statusCode, text, json } = await nativeHttpPostJson(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    },
    CLOUD_TIMEOUT_MS,
  );
  if (statusCode < 200 || statusCode >= 300) throw providerError('OpenAI', statusCode, text);
  const data = json as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callOllama(content: string, ollamaUrl: string, media?: ParseMedia): Promise<string> {
  const base = ollamaUrl.replace(/\/+$/, '');
  // Ollama attaches images as a base64 array on the message itself. Note
  // that it accepts this against ANY model: a text-only one silently drops
  // the image and answers from the prompt alone, which is why the error
  // text elsewhere in this file mentions needing a vision model rather
  // than assuming the request shape is enough.
  const userMessage: Record<string, unknown> = { role: 'user', content };
  if (media) userMessage.images = [media.data];
  const { statusCode, text, json } = await nativeHttpPostJson(
    `${base}/api/chat`,
    {},
    {
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        userMessage,
      ],
      options: {
        temperature: 0.1,
        num_predict: 1500,
      },
    },
    OLLAMA_TIMEOUT_MS,
  );
  if (statusCode < 200 || statusCode >= 300) throw providerError('Ollama', statusCode, text);
  const data = json as { message?: { content?: string } };
  return data?.message?.content ?? '';
}

/** Dispatches to the configured provider. Throws rather than falling back:
 *  a cloud provider selected with no key is a settings mistake the user
 *  needs told about, not a reason to silently spend a different provider's
 *  quota — same rule as the backend's callConfiguredProvider(). */
async function callConfiguredProvider(content: string, media?: ParseMedia): Promise<string> {
  const settings = await getLlmSettings();
  // Checked before the key check on purpose: "Gemini can't do video" is
  // the more useful sentence than "no key saved" when both are true, since
  // pasting a key wouldn't have helped.
  if (media) assertMediaSupported(settings.provider, media);

  if (settings.provider === 'anthropic') {
    if (!settings.keys.anthropic) throw new Error('Anthropic is selected but no API key is saved — add one under Account → AI Provider.');
    return callAnthropic(content, settings.keys.anthropic, media);
  }
  if (settings.provider === 'gemini') {
    if (!settings.keys.gemini) throw new Error('Google Gemini is selected but no API key is saved — add one under Account → AI Provider.');
    return callGemini(content, settings.keys.gemini, media);
  }
  if (settings.provider === 'openai') {
    if (!settings.keys.openai) throw new Error('OpenAI is selected but no API key is saved — add one under Account → AI Provider.');
    return callOpenAI(content, settings.keys.openai, media);
  }
  return callOllama(content, settings.ollamaUrl || DEFAULT_OLLAMA_URL, media);
}

// ── Response handling ───────────────────────────────────────────────────
// repairTruncatedJson() and parseJsonResponse() are ported from
// llm.parser.ts unchanged. The truncation repair matters more here, not
// less: standalone mode is the configuration most likely to be pointed at
// a small local model whose output runs into the token budget mid-array.

function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafeIndex = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); lastSafeIndex = i; }
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    else if (ch === ',') lastSafeIndex = i;
  }

  if (lastSafeIndex === -1) return raw;

  let truncated = raw.slice(0, lastSafeIndex + 1);
  if (truncated.trimEnd().endsWith(',')) truncated = truncated.trimEnd().slice(0, -1);

  const reStack: string[] = [];
  inString = false;
  escape = false;
  for (const ch of truncated) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') reStack.push(ch);
    else if (ch === '}' && reStack[reStack.length - 1] === '{') reStack.pop();
    else if (ch === ']' && reStack[reStack.length - 1] === '[') reStack.pop();
  }
  if (inString) truncated += '"';
  for (let i = reStack.length - 1; i >= 0; i--) {
    truncated += reStack[i] === '{' ? '}' : ']';
  }
  return truncated;
}

function parseJsonResponse(raw: string, baseUrl?: string): TemplateParseResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*/);
  if (!jsonMatch) throw new Error('The model did not return any JSON — try again, or switch provider.');

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = JSON.parse(repairTruncatedJson(jsonMatch[0]));
  }

  return {
    title: parsed.title ?? 'Ricetta senza titolo',
    language: typeof parsed.language === 'string' && /^[a-z]{2}$/i.test(parsed.language.trim())
      ? parsed.language.trim().toLowerCase()
      : undefined,
    description: parsed.description ?? undefined,
    servings: typeof parsed.servings === 'number' ? parsed.servings : undefined,
    prepTimeMin: typeof parsed.prepTimeMin === 'number' ? parsed.prepTimeMin : undefined,
    cookTimeMin: typeof parsed.cookTimeMin === 'number' ? parsed.cookTimeMin : undefined,
    restTimeMin: typeof parsed.restTimeMin === 'number' ? parsed.restTimeMin : undefined,
    difficulty: ['easy', 'medium', 'hard', 'expert'].includes(parsed.difficulty)
      ? parsed.difficulty
      : 'medium',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === 'string') : [],
    storageInstructions: typeof parsed.storageInstructions === 'string' ? parsed.storageInstructions : null,
    tips: typeof parsed.tips === 'string' ? parsed.tips : null,
    ingredients: Array.isArray(parsed.ingredients)
      ? parsed.ingredients.map((ing: any, i: number) => ({
          name: ing.name ?? `Ingrediente ${i + 1}`,
          quantity: typeof ing.quantity === 'number' ? ing.quantity : undefined,
          quantityText: ing.quantityText ?? undefined,
          unit: ing.unit ?? undefined,
          notes: ing.notes ?? undefined,
          groupName: typeof ing.groupName === 'string' ? ing.groupName : null,
          isOptional: ing.isOptional === true,
        }))
      : [],
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((step: any, i: number) => ({
          stepNumber: step.stepNumber ?? i + 1,
          title: step.title ?? undefined,
          description: step.description ?? '',
          durationMin: typeof step.durationMin === 'number' ? step.durationMin : undefined,
          techniques: Array.isArray(step.techniques) ? step.techniques.filter((t: unknown) => typeof t === 'string') : [],
        }))
      : [],
    sourceUrl: undefined,
    // Resolved and validated rather than trusted: a model will happily
    // return a relative path, a `data:` blob or a plausible-looking URL it
    // made up. absoluteImageUrl() drops everything that isn't a real remote
    // http(s) address; the caller then falls back to the page's own
    // og:image when this comes back empty.
    imageUrl: absoluteImageUrl(typeof parsed.imageUrl === 'string' ? parsed.imageUrl : null, baseUrl) ?? undefined,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

/** Same tag-stripping and 6 000-character cut as the backend's
 *  fetchUrlContent(). The cap is not only about token spend: it is what
 *  keeps a local CPU-only model's prefill inside the timeout, and the
 *  recipe itself is almost always within it. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, '')
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

export interface LocalParseRequest {
  input: string;
  inputType: 'url' | 'text' | 'media';
  /** Required when inputType is 'media'. `input` then carries whatever
   *  extra context the user typed (or '' for none) rather than the recipe
   *  itself. */
  media?: ParseMedia;
}

/** What to tell the model about a file it is being handed. The prompt
 *  itself stays the shared SYSTEM_PROMPT — this only names the medium, so
 *  the model treats a transcript-shaped input as a recipe being dictated
 *  rather than as prose to summarize. Italian, like the system prompt, for
 *  the same reason: the two are read together and the unit-normalization
 *  rule is written against Italian. */
const MEDIA_INSTRUCTION: Record<MediaKind, string> = {
  image: "Estrai la ricetta dall'immagine allegata (una foto, una scansione o uno screenshot di una pagina di ricetta). Leggi tutto il testo visibile, comprese le liste di ingredienti e i passaggi.",
  document: 'Estrai la ricetta dal documento allegato.',
  audio: "Ascolta l'audio allegato: è qualcuno che racconta o detta una ricetta. Trascrivila mentalmente e restituisci la ricetta strutturata. Gli ingredienti e le quantità possono essere detti in modo informale (\"un paio di cucchiai\") — in quel caso usa quantityText.",
  video: "Guarda il video allegato: è una preparazione di cucina. Usa sia il parlato sia ciò che si vede (ingredienti inquadrati, testo sovrimpresso) per ricostruire la ricetta. Se una quantità non viene mai detta né mostrata, lascia quantity a null invece di inventarla.",
};

/** Standalone mode's POST /api/recipes/parse. Returns the model's result
 *  UNMATCHED, exactly like the backend route — matching is the Review
 *  Matches step's job (services/matchSuggestions.ts, which already routes
 *  to localMatcher.ts here), so importing never silently creates a new
 *  ingredient the user has not seen. */
export async function parseRecipeLocally(req: LocalParseRequest): Promise<TemplateParseResult> {
  // A file goes up alongside the prompt rather than being flattened to
  // text first. OCR (services/migration/ocr.ts) still exists and is still
  // the right tool for a clean scan of printed text — it is free, offline
  // and exact — but it has nothing to say about a voice note, a clip, or a
  // handwritten card, and it throws away the layout that tells a model
  // which column is the ingredient list.
  if (req.inputType === 'media') {
    if (!req.media?.data) throw new Error('No file was attached.');
    const kind = mediaKindFor(req.media.mimeType);
    if (!kind) throw new Error(`SmartChef doesn't know what to do with a ${req.media.mimeType || 'file of that type'}.`);
    const extra = req.input.trim();
    const prompt = `${MEDIA_INSTRUCTION[kind]}${extra ? `

Note aggiuntive dall'utente:
${extra}` : ''}`;
    const rawMedia = await callConfiguredProvider(prompt, req.media);
    return parseJsonResponse(rawMedia);
  }

  let content: string;
  // The cover image the page nominates for itself. Captured here because
  // the model never sees the page's HTML — only stripped text — so without
  // this an imported recipe had no cover at all on the AI path, while the
  // structured-data path (recipeStructuredData.ts) has always set one.
  let pageImage: string | null = null;

  if (req.inputType === 'url') {
    const html = await fetchPageHtml(req.input);
    // An Instagram post's recipe lives in the page metadata, not the page
    // body — stripping tags off its JS shell yields the single word
    // "Instagram". extractSocialCaption() returns null for every ordinary
    // recipe site, so the normal path is untouched.
    const caption = extractSocialCaption(req.input, html);
    pageImage = extractPageImage(req.input, html);
    content = (caption ?? htmlToPlainText(html)).slice(0, 6000);
    // Offered to the model rather than simply forced: on a page with one
    // og:image this is just a confirmation, but the model can reject it
    // (a logo, a category banner) or pick a better URL if the text names
    // one. Appended AFTER the 6 000-character cut so a long page can never
    // truncate the candidate away.
    if (pageImage) {
      content += `\n\nImmagine di copertina della pagina: ${pageImage}`;
    }
  } else {
    content = req.input;
  }

  if (!content.trim()) {
    throw new Error(
      'There was no readable recipe text at that address. If it is a social post, the recipe has to be in the caption.',
    );
  }

  const raw = await callConfiguredProvider(`Analizza questa ricetta:\n\n${content}`);
  const result = parseJsonResponse(raw, req.inputType === 'url' ? req.input : undefined);
  if (req.inputType === 'url') {
    result.sourceUrl = req.input;
    // The page's own og:image is the fallback, not the override: a model
    // that identified a better image in the text keeps it.
    if (!result.imageUrl && pageImage) result.imageUrl = pageImage;
  }
  return result;
}
