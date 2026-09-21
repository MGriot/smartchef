# Getting recipes in, and out

Importing from a website, a photo, a scan or a voice note; cooking from
what is already in the cupboard; and sharing a single recipe with someone
who has no account.

> Part of the [SmartChef documentation](../README.md#documentation).

---

## 📥 Bringing recipes in from elsewhere

The Import screen has four ways in, and they are tried in order of how much
they can be trusted.

**A URL.** Most recipe sites publish their recipe as schema.org JSON-LD or
microdata, which is the actual structured data behind the page — exact
quantities, units, yields and ISO-8601 times. SmartChef reads that first and
only falls back to the LLM when a page has neither. That is not a small
difference: the LLM path truncates the page to fit a context window and
spends minutes of CPU inference, where the structured path is a parse.

**A file exported from another app.** Paprika (`.paprikarecipes`), Mealie,
Crouton, Mela, Nextcloud Cookbook and CopyMeThat, plus bare schema.org JSON.
Zip and gzip archives are unpacked in the browser.

**A PDF.** Text is extracted directly when the file has a text layer.

**A photo.** OCR runs on your own device via Tesseract — no image is
uploaded anywhere. The language model for a language is downloaded once
(~12 MB) and cached, so the first photo needs a connection and none after it
do. Printed pages photographed straight-on read well; handwriting is
genuinely hit and miss, which is why extracted text lands in the review box
rather than importing straight off.

### Matching what's already in your library

Every import, however it got in, goes through a fuzzy name matcher against
your existing ingredients, tools and techniques before anything is created,
so "400g San Marzano tomatoes" resolves to the tomato you already have
rather than minting a duplicate.

The AI import path (URL, raw text, PDF text or photo, run through the LLM)
goes one step further: the model is handed your library's own names —
labelled in your recipe language, so it can recognize "Burro" as
"Butter" — and asked which entry each ingredient, tool and technique
corresponds to. That catches matches string similarity alone would miss
(a recipe's "planetaria" against your library's "Stand Mixer"), without
letting the model coin its own name for something you already have. Every
such claim is checked against the exact list the model was shown before
anything acts on it, so a plausible-sounding invention is rejected rather
than trusted; a match found only this way is badged **AI match** in the
Review Matches step instead of being auto-selected unmarked.

---

## 🥫 Pantry — what can I cook right now?

Record what's in the house (Pantry tab), then ask what it lets you cook.

An entry with no quantity means "I have some" and satisfies any amount —
being made to weigh the flour before the app will accept it is exactly the
friction that stops anyone keeping a pantry current. Optional ingredients
never count against a recipe, and an amount that can't be compared (a pinch,
a different kind of unit) is assumed to be fine rather than hiding the
recipe.

The match resolves **through the Matrioska engine**, so a dish whose sauce is
itself a recipe is judged on the sauce's ingredients too — the one thing
none of the comparable apps can do, since none of them have nested recipes.
Loosen the filter to see near-misses and what's short.

---

## 🔗 Sharing a recipe with someone who has no account

Server mode only, and deliberately: a public URL needs a server that is
running and reachable, which is the one thing standalone mode is defined by
not having. The offline builds say so and offer the file export instead.

From a recipe page, **Share → Create public link** mints a token and gives
you a URL. Opening it needs no account. What the visitor gets is an
allowlist built field by field — not the internal recipe minus a few keys,
which silently publishes every column added later. Creator, ratings and cook
log are not included, and internal step references are stripped rather than
leaking ids.

The token is the credential, so it is 32 bytes of crypto-quality randomness
and never derived from the recipe id — a guessable token would make every
recipe public at once. Links can carry an expiry or run until revoked, and
revoking deletes the link rather than touching the recipe.

`/api/public/r/:token` is a real server-rendered HTML page rather than JSON,
because a link pasted into a chat gets previewed by fetching it as a
document: JSON yields no title, image or description.

---
