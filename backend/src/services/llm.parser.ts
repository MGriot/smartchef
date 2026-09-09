// ════════════════════════════════════════════════════════════════════════
// SmartChef — LLM Parser Service (Ollama)
// Analizza testo/URL di ricette e mappa i campi nel DB
// ════════════════════════════════════════════════════════════════════════

import { Agent, setGlobalDispatcher } from "undici";
import type { LLMParseRequest, LLMParseResult } from "@shared/types/index";
import { queryOne } from "../db/pool";
import { decrypt } from "./crypto.service";
import { callAnthropic, callGemini, callOpenAI } from "./llm.providers";

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
      "groupName": "string | null"
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
  "confidence": "number (0-1)",
  "warnings": ["string"]
}

Regole:
- restTimeMin è il tempo di attesa/riposo (lievitazione, marinatura, raffreddamento) separato dal tempo di preparazione attiva
- tools è l'elenco degli strumenti/attrezzi da cucina menzionati o chiaramente necessari (es. "forno", "planetaria", "frullatore"), nomi brevi e generici
- storageInstructions è come conservare gli avanzi ("Come conservare"), tips sono consigli generali distinti dalla description — entrambi null se non menzionati
- groupName (negli ingredienti) è un'intestazione breve e opzionale sotto cui questo ingrediente è raggruppato, es. "Per il condimento" — impostalo SOLO quando la ricetta originale raggruppa visivamente gli ingredienti in sezioni etichettate; altrimenti lascialo null. Non inventare raggruppamenti assenti nella fonte
- techniques (negli step) è l'elenco delle tecniche di cottura riconosciute in quello step (es. "Rosolare", "Brasare"), nomi brevi, stesso criterio di "tools"
- Se una quantità è vaga (es. "q.b.", "a piacere"), metti null in quantity e il testo in quantityText
- Normalizza le unità in italiano (grammi, ml, cucchiai, ecc.)
- Stima la difficoltà basandoti sul numero di step e tecniche usate
- Se non riesci a estrarre un campo, usa null
- Aggiungi warnings per informazioni ambigue o mancanti
- confidence deve riflettere quanto sei sicuro dell'estrazione (1.0 = perfetto)`;

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
  assertSafeImportUrl(url);
  const response = await fetch(url, { headers: IMPORT_FETCH_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const html = await response.text();
  return html.length > 4_000_000 ? html.slice(0, 4_000_000) : html;
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

async function fetchUrlContent(url: string): Promise<string> {
  assertSafeImportUrl(url);
  // Aggiungiamo header più completi per bypassare firewall basici
  const response = await fetch(url, {
    headers: {
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
  // Rimuovi tag HTML per semplificare il testo
  return html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
             .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim()
             .slice(0, 6000); // ridotto da 10000: meno prefill su CPU-only inference, il contenuto della ricetta è quasi sempre entro questa soglia
}

/**
 * Chiama Ollama con un system prompt arbitrario — usato sia per il parsing
 * ricette (SYSTEM_PROMPT) sia per la traduzione contenuti ricetta.
 */
async function callOllama(content: string, systemPrompt: string, ollamaUrl: string = OLLAMA_URL): Promise<string> {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
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
export async function callConfiguredProvider(content: string, systemPrompt: string): Promise<string> {
  const account = await queryOne<LLMAccountConfig>(
    `SELECT llm_provider, anthropic_api_key_encrypted, gemini_api_key_encrypted, openai_api_key_encrypted, ollama_url FROM account LIMIT 1`
  );
  const provider = account?.llm_provider ?? "ollama";

  if (provider === "anthropic") {
    if (!account?.anthropic_api_key_encrypted) {
      throw new Error("Anthropic selected but no API key configured — add one in Account settings");
    }
    return callAnthropic(content, decrypt(account.anthropic_api_key_encrypted), systemPrompt);
  }
  if (provider === "gemini") {
    if (!account?.gemini_api_key_encrypted) {
      throw new Error("Gemini selected but no API key configured — add one in Account settings");
    }
    return callGemini(content, decrypt(account.gemini_api_key_encrypted), systemPrompt);
  }
  if (provider === "openai") {
    if (!account?.openai_api_key_encrypted) {
      throw new Error("OpenAI selected but no API key configured — add one in Account settings");
    }
    return callOpenAI(content, decrypt(account.openai_api_key_encrypted), systemPrompt);
  }
  return callOllama(content, systemPrompt, resolveOllamaUrl(account?.ollama_url));
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
function parseJsonResponse(raw: string): LLMParseResult {
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
          quantity: typeof ing.quantity === "number" ? ing.quantity : undefined,
          quantityText: ing.quantityText ?? undefined,
          unit: ing.unit ?? undefined,
          notes: ing.notes ?? undefined,
          groupName: typeof ing.groupName === "string" ? ing.groupName : null,
        }))
      : [],
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((step: any, i: number) => ({
          stepNumber: step.stepNumber ?? i + 1,
          title: step.title ?? undefined,
          description: step.description ?? "",
          durationMin: typeof step.durationMin === "number" ? step.durationMin : undefined,
          techniques: Array.isArray(step.techniques) ? step.techniques.filter((t: unknown) => typeof t === "string") : [],
        }))
      : [],
    sourceUrl: undefined,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

/**
 * Entry point principale del parser LLM
 */
export async function parseRecipeWithLLM(req: LLMParseRequest): Promise<LLMParseResult> {
  let content: string;

  if (req.inputType === "url") {
    content = await fetchUrlContent(req.input);
  } else {
    content = req.input;
  }

  const rawResponse = await callConfiguredProvider(`Analizza questa ricetta:\n\n${content}`, SYSTEM_PROMPT);
  const result = parseJsonResponse(rawResponse);

  if (req.inputType === "url") {
    result.sourceUrl = req.input;
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
