// ════════════════════════════════════════════════════════════════════════
// SmartChef — Cloud LLM providers for recipe-import parsing (Anthropic,
// Gemini, OpenAI), as an opt-in alternative to the local Ollama instance
// in llm.parser.ts. Hand-rolled fetch() calls, matching the existing
// Ollama integration's style, rather than adding three SDK dependencies.
//
// Each call optionally carries media (a photo, a scan, a PDF, a voice
// note, a clip) as a LIST, because one recipe is often two cookbook pages
// or three photographs — see llm.parser.ts assertMediaListSupported() for
// why only images may arrive as a set. Previously ONE piece of media
// (a photo, a scan, a PDF,
// a voice note, a clip). The prompt is unchanged either way — only the
// shape of the user turn differs, and it differs per provider: Anthropic
// wants base64 in an image/document block, Gemini wants inlineData (the
// only one of the three that also takes audio and video), OpenAI wants a
// data URI in an image_url part. Which provider may read which kind is
// decided by llm.parser.ts's MEDIA_SUPPORT, not here.
//
// Mirrors frontend/src/services/llmParser.local.ts's own provider calls,
// deliberately, on the terms that file's header already states: the two
// runtimes share no code (no encrypted key columns in a browser, no native
// HTTP bridge on a server) but MUST NOT drift on the request shape.
// Change one, change the other.
// ════════════════════════════════════════════════════════════════════════

import type { LLMParseMedia } from "@shared/types/index";

// Cloud APIs return in seconds, not the ~10 minutes local CPU-only Ollama
// inference can take — a much shorter ceiling than callOllama's 600_000ms.
const CLOUD_TIMEOUT_MS = 60_000;

// Cheap/fast tier by default for each provider — recipe parsing is a
// lightweight structured-extraction task, not something needing frontier
// reasoning, and the default matters since this is real per-call spend
// once a user opts in to a cloud provider.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
// gemini-2.0-flash was retired mid-2026 (HTTP 404, "no longer available
// ... use models/gemini-3.6-flash"). Override with GEMINI_MODEL.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export async function callAnthropic(
  content: string,
  apiKey: string,
  systemPrompt: string,
  media?: LLMParseMedia[]
): Promise<string> {
  // A media turn is content BLOCKS rather than a bare string; the file goes
  // first so the text after it reads as an instruction about it, which is
  // what Anthropic's own guidance asks for.
  const userContent: unknown = media?.length
    ? [
        ...media.map((m) =>
          m.mimeType.toLowerCase().startsWith("application/pdf")
            ? { type: "document", source: { type: "base64", media_type: m.mimeType, data: m.data } }
            : { type: "image", source: { type: "base64", media_type: m.mimeType, data: m.data } }
        ),
        { type: "text", text: content },
      ]
    : content;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      // No temperature/top_p/top_k — current Claude models return HTTP 400
      // on any non-default sampling param. No thinking config — adaptive
      // default is fine for this structured-extraction task.
    }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  if (data.stop_reason === "refusal") throw new Error("Anthropic declined the request (safety classifier)");
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

export async function callGemini(
  content: string,
  apiKey: string,
  systemPrompt: string,
  media?: LLMParseMedia[]
): Promise<string> {
  // inlineData covers images, PDFs, audio AND video with one shape — the
  // reason the capability table steers a voice note or a clip here.
  const parts: Array<Record<string, unknown>> = media?.length
    ? [...media.map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.data } })), { text: content }]
    : [{ text: content }];
  const response = await fetch(
    // The key travels in a header, not the `?key=` query parameter this
    // used to use: a URL query string is the one place a credential
    // reliably ends up somewhere it should not be (access logs, proxy
    // logs, error reports). Same API either way, and the same call the
    // standalone twin makes.
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }],
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    }
  );

  if (!response.ok) throw new Error(`Gemini error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function callOpenAI(
  content: string,
  apiKey: string,
  systemPrompt: string,
  media?: LLMParseMedia[]
): Promise<string> {
  // OpenAI takes an image as a data URI in an image_url part rather than as
  // raw base64 — the one provider here that does.
  const userContent: unknown = media?.length
    ? [
        ...media.map((m) => ({ type: "image_url", image_url: { url: `data:${m.mimeType};base64,${m.data}` } })),
        { type: "text", text: content },
      ]
    : content;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
