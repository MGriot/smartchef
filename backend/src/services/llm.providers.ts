// ════════════════════════════════════════════════════════════════════════
// SmartChef — Cloud LLM providers for recipe-import parsing (Anthropic,
// Gemini, OpenAI), as an opt-in alternative to the local Ollama instance
// in llm.parser.ts. Hand-rolled fetch() calls, matching the existing
// Ollama integration's style, rather than adding three SDK dependencies.
// ════════════════════════════════════════════════════════════════════════

// Cloud APIs return in seconds, not the ~10 minutes local CPU-only Ollama
// inference can take — a much shorter ceiling than callOllama's 600_000ms.
const CLOUD_TIMEOUT_MS = 60_000;

// Cheap/fast tier by default for each provider — recipe parsing is a
// lightweight structured-extraction task, not something needing frontier
// reasoning, and the default matters since this is real per-call spend
// once a user opts in to a cloud provider.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

function userMessage(content: string): string {
  return `Analizza questa ricetta:\n\n${content}`;
}

export async function callAnthropic(content: string, apiKey: string, systemPrompt: string): Promise<string> {
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
      messages: [{ role: "user", content: userMessage(content) }],
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

export async function callGemini(content: string, apiKey: string, systemPrompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage(content) }] }],
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

export async function callOpenAI(content: string, apiKey: string, systemPrompt: string): Promise<string> {
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
        { role: "user", content: userMessage(content) },
      ],
    }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
