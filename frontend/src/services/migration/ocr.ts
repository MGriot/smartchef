// ════════════════════════════════════════════════════════════════════════
// SmartChef — Reading a recipe out of a photo
//
// Tesseract, in the browser, on the user's own device. That choice is the
// point rather than an implementation detail: Mealie's OCR and its
// video-transcription both call OpenAI, and Cooklang's CLI scraper needs an
// OpenAI key. Doing this locally keeps the promise that nothing leaves the
// machine — which is the sharpest answer this product has to "why not just
// use Mealie".
//
// ── Honest limits, surfaced in the UI rather than buried here ───────────
//   - The engine and its wasm are bundled, but the LANGUAGE MODEL is
//     downloaded on first use (~12 MB per language) and then cached in
//     IndexedDB by tesseract.js. So the first photo needs a network
//     connection; every one after that does not.
//   - Printed pages photographed straight-on read well. Handwriting is
//     genuinely hit and miss — the Import screen's review step is not
//     optional for this path, and the copy says so.
//
// Dynamically imported throughout: tesseract.js plus its wasm is several
// megabytes, and nobody who never imports a photo should pay for it at
// startup.
// ════════════════════════════════════════════════════════════════════════

export interface OcrProgress {
  /** 0-1, or null while the stage has no measurable progress. */
  ratio: number | null;
  /** 'loading' while the model downloads, 'recognising' once it is reading. */
  stage: 'loading' | 'recognising';
}

/** Tesseract's three-letter codes for the languages the app itself speaks.
 *  Passing several at once lets it read a recipe that mixes them, at the
 *  cost of another model download each. */
const LANG_BY_UI: Record<string, string> = {
  en: 'eng',
  it: 'ita',
  fr: 'fra',
  es: 'spa',
};

export function ocrLanguageFor(uiLanguage: string | undefined): string {
  return LANG_BY_UI[(uiLanguage || 'en').slice(0, 2).toLowerCase()] ?? 'eng';
}

/** Roughly what the first run of a language costs, for the warning shown
 *  before anyone commits to it. */
export const OCR_MODEL_MB = 12;

export async function readImageText(
  file: Blob,
  language: string,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const { createWorker } = await import('tesseract.js');

  // The engine and wasm are bundled with the app; only the language model
  // comes from the network. Vite emits these as hashed assets.
  const workerPath = (await import('tesseract.js/dist/worker.min.js?url')).default;
  const corePath = (await import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url')).default;

  const worker = await createWorker(language, 1, {
    workerPath,
    corePath,
    logger: (m: { status?: string; progress?: number }) => {
      if (!onProgress) return;
      const stage = m.status === 'recognizing text' ? 'recognising' : 'loading';
      onProgress({ stage, ratio: typeof m.progress === 'number' ? m.progress : null });
    },
  });

  try {
    const { data } = await worker.recognize(file);
    return cleanOcrText(data.text ?? '');
  } finally {
    // Always terminated: the worker holds the wasm heap, and leaking one
    // per import would grow memory until the app is restarted.
    await worker.terminate();
  }
}

/** OCR output is ragged in ways that matter to everything downstream: a
 *  wrapped ingredient line arrives as two lines, and stray single
 *  characters come from specks on the page. */
export function cleanOcrText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    // A lone character on its own line is noise, not an ingredient.
    .filter((line) => line.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
