// ════════════════════════════════════════════════════════════════════════
// One-off maintenance script: populates the it/fr/es UI locale JSON files
// from the canonical en.json using the local Ollama model, for every key
// not yet present in the target locale. Local small-model translation, not
// human-reviewed — spot-check the output the same way the ingredient
// backfill was checked. Run once via:
//   npx ts-node src/scripts/translate-ui-locales.ts
// (requires OLLAMA_URL reachable — defaults to http://localhost:11434)
// Safe to re-run — only translates keys still missing from a target file.
// ════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { translateUiStrings } from "../services/llm.parser";

const LOCALES_DIR = path.join(__dirname, "../../../frontend/src/i18n/locales");
const TARGET_LANGS = ["it", "fr", "es"];
const CHUNK_SIZE = 15;

type Tree = { [key: string]: string | Tree };

function flatten(obj: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

function setPath(obj: Tree, dottedKey: string, value: string) {
  const parts = dottedKey.split(".");
  let cur: Tree = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Tree;
  }
  cur[parts[parts.length - 1]] = value;
}

function readJson(file: string): Tree {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

async function main() {
  const enPath = path.join(LOCALES_DIR, "en.json");
  const en = readJson(enPath);
  const enFlat = flatten(en);
  const enKeys = Object.keys(enFlat);
  console.log(`Canonical en.json has ${enKeys.length} keys.`);

  for (const lang of TARGET_LANGS) {
    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    const existing = readJson(filePath);
    const existingFlat = flatten(existing);

    const missingKeys = enKeys.filter((k) => !existingFlat[k]);
    if (missingKeys.length === 0) {
      console.log(`[${lang}] nothing to do — already has every key.`);
      continue;
    }
    console.log(`[${lang}] translating ${missingKeys.length} missing keys...`);

    const merged: Tree = JSON.parse(JSON.stringify(existing));
    let translatedCount = 0;

    for (let i = 0; i < missingKeys.length; i += CHUNK_SIZE) {
      const chunkKeys = missingKeys.slice(i, i + CHUNK_SIZE);
      const chunkValues = chunkKeys.map((k) => enFlat[k]);
      console.log(`  [${lang}] chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(missingKeys.length / CHUNK_SIZE)}: ${chunkValues.length} strings...`);

      let result: Record<string, string> = {};
      try {
        result = await translateUiStrings(chunkValues, lang);
      } catch (err) {
        console.warn(`  [${lang}] chunk failed, skipping:`, (err as Error).message);
        continue;
      }

      for (const key of chunkKeys) {
        const original = enFlat[key];
        const translated = result[original];
        if (!translated) {
          console.warn(`  [${lang}] no translation returned for key "${key}" ("${original}")`);
          continue;
        }
        setPath(merged, key, translated);
        translatedCount++;
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(`[${lang}] done — ${translatedCount}/${missingKeys.length} translated, written to ${filePath}`);
  }

  console.log("All locales processed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Translation script failed:", err);
  process.exit(1);
});
