// ════════════════════════════════════════════════════════════════════════
// Importing an Instagram post.
//
// Instagram answers a browser User-Agent with a ~650KB JavaScript shell
// whose entire visible text is the word "Instagram", so Smart Import used
// to hand the model no content at all for a reel/post link and produce an
// empty recipe with no explanation. The post's text is published only to a
// crawler-shaped request, as page metadata.
//
// The fixture below is the real shape of that metadata, taken from a live
// public reel (the framing prefix, the &quot; wrapping, the newlines, and
// the &#xb0; in the oven temperature are all verbatim). Kept as a fixture
// rather than a live fetch so the suite stays offline and deterministic —
// the live behaviour was verified once, by hand, against that same reel.
//
// The second half of this file is the part that protects everything else:
// extraction MUST stay off ordinary recipe sites, whose <meta
// name="description"> is a 160-character SEO blurb. Preferring that over
// the page body would silently turn every working import into an empty one.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  extractSocialCaption,
  isCaptionOnlyHost,
  assertImportableUrl,
  extractPageImage,
  absoluteImageUrl,
} from './pageFetcher';

/** og:description, as Instagram serves it — truncated mid-word, which is
 *  why it cannot be the primary source: the ingredients are past the cut. */
const OG_DESCRIPTION =
  '13K likes, 118 comments - recipesbyanne on June 7, 2023: &quot;This viral easy Boursin Cheese Baked Pasta recipe will take your breath away! I honestly found the classic recipe a bit bland and tasteless, so I added sun-d';

/** <meta name="description"> — the whole caption, newlines intact. */
const FULL_DESCRIPTION = `13K likes, 118 comments - recipesbyanne on June 7, 2023: &quot;This viral easy Boursin Cheese Baked Pasta recipe will take your breath away!

Ingredients:
250g uncooked pasta
1 Boursin cheese
125g sun-dried tomatoes in oil

Directions:
Preheat oven to 210&#xb0;C. Mix cherry tomatoes &amp; Boursin in a dish.
Cook pasta in salted water.

#bakedpasta #boursin&quot;. `;

const IG_HTML = `<!DOCTYPE html><html><head>
<meta property="instapp:owner_user_id" content="45942370254" />
<meta name="description" content="${FULL_DESCRIPTION}" />
<meta property="og:site_name" content="Instagram" />
<meta property="og:description" content="${OG_DESCRIPTION}" />
</head><body><div id="react-root"></div></body></html>`;

describe('Instagram caption extraction', () => {
  it('recognises Instagram hosts, with or without www', () => {
    expect(isCaptionOnlyHost(new URL('https://www.instagram.com/reel/CtMXPf7gIB0/'))).toBe(true);
    expect(isCaptionOnlyHost(new URL('https://instagram.com/p/CtMXPf7gIB0/'))).toBe(true);
    // Not a suffix match on something merely ending in the same letters.
    expect(isCaptionOnlyHost(new URL('https://notinstagram.com/p/x/'))).toBe(false);
    expect(isCaptionOnlyHost(new URL('https://www.giallozafferano.it/x.html'))).toBe(false);
  });

  it('prefers the full description over the truncated og:description', () => {
    const caption = extractSocialCaption('https://www.instagram.com/reel/CtMXPf7gIB0/', IG_HTML)!;

    expect(caption).toContain('125g sun-dried tomatoes in oil');
    expect(caption).toContain('Directions:');
    // The og: variant stops at "sun-d" — reaching the ingredients at all
    // proves the full tag won.
    expect(caption).not.toMatch(/sun-d$/);
  });

  it('keeps the newlines that make the ingredients a list', () => {
    const caption = extractSocialCaption('https://www.instagram.com/reel/CtMXPf7gIB0/', IG_HTML)!;
    const lines = caption.split('\n').map((l) => l.trim()).filter(Boolean);

    expect(lines).toContain('Ingredients:');
    expect(lines).toContain('250g uncooked pasta');
    expect(lines).toContain('1 Boursin cheese');
  });

  it('decodes named and numeric entities', () => {
    const caption = extractSocialCaption('https://www.instagram.com/reel/CtMXPf7gIB0/', IG_HTML)!;

    expect(caption).toContain('210°C'); // &#xb0;
    expect(caption).toContain('tomatoes & Boursin'); // &amp;
    expect(caption).not.toContain('&quot;');
    expect(caption).not.toContain('&#x');
    expect(caption).not.toContain('&amp;');
  });

  it('strips the likes/comments framing so it cannot land in the recipe', () => {
    const caption = extractSocialCaption('https://www.instagram.com/reel/CtMXPf7gIB0/', IG_HTML)!;

    expect(caption).not.toMatch(/likes/);
    expect(caption).not.toMatch(/comments/);
    expect(caption.startsWith('This viral easy Boursin')).toBe(true);
    // The trailing `". ` of the framing is gone too, but the caption's own
    // last line survives.
    expect(caption.trimEnd().endsWith('#bakedpasta #boursin')).toBe(true);
  });

  it('passes an unrecognised framing through rather than cutting into it', () => {
    // Instagram could change this wording at any time; guessing wrong must
    // never remove recipe text.
    const html = '<meta name="description" content="Some other shape entirely: 250g pasta">';
    const caption = extractSocialCaption('https://www.instagram.com/p/X/', html)!;

    expect(caption).toBe('Some other shape entirely: 250g pasta');
  });

  it('handles content-before-name attribute order', () => {
    const html = '<meta content="Ingredients: 250g pasta" name="description" />';
    expect(extractSocialCaption('https://www.instagram.com/p/X/', html)).toBe('Ingredients: 250g pasta');
  });

  it('returns null when the metadata is missing or empty', () => {
    expect(extractSocialCaption('https://www.instagram.com/p/X/', '<html><head></head></html>')).toBeNull();
    expect(extractSocialCaption('https://www.instagram.com/p/X/', '<meta name="description" content="  " />')).toBeNull();
  });

  it('NEVER extracts from an ordinary recipe site', () => {
    // The regression this guards: a normal page's meta description is a
    // short SEO blurb, and using it instead of the page body would replace
    // a working import with an almost-empty one.
    const html = '<html><head><meta name="description" content="An easy pasta bake in 30 minutes."></head><body>…the full recipe…</body></html>';

    expect(extractSocialCaption('https://www.giallozafferano.it/pasta.html', html)).toBeNull();
    expect(extractSocialCaption('https://example.com/r', html)).toBeNull();
  });

  it('returns null for an unparseable URL instead of throwing', () => {
    expect(extractSocialCaption('not a url', IG_HTML)).toBeNull();
  });

  it('still accepts Instagram URLs through the import-URL guard', () => {
    // The SSRF-shaped guard rejects private hosts; a public social link
    // must pass it, share-tracking query string and all.
    expect(() => assertImportableUrl('https://www.instagram.com/reel/CtMXPf7gIB0/?igsh=MTBhOA==')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Cover image for an AI-parsed import.
//
// The model is shown the page as STRIPPED TEXT, so it cannot see an image
// URL unless one is handed to it — which is why AI imports produced
// recipes with no cover while the structured-data path always set one.
// extractPageImage() is what supplies the candidate (and the fallback when
// the model returns nothing).
// ════════════════════════════════════════════════════════════════════════

describe('cover image extraction', () => {
  it('prefers og:image', () => {
    const html = `<meta property="og:image" content="https://cdn.example/dish.jpg" />
                  <meta name="twitter:image" content="https://cdn.example/other.jpg" />`;
    expect(extractPageImage('https://site.example/r', html)).toBe('https://cdn.example/dish.jpg');
  });

  it('falls back to og:image:url then twitter:image', () => {
    expect(
      extractPageImage('https://site.example/r', '<meta property="og:image:url" content="https://cdn.example/a.jpg">')
    ).toBe('https://cdn.example/a.jpg');
    expect(
      extractPageImage('https://site.example/r', '<meta name="twitter:image" content="https://cdn.example/b.jpg">')
    ).toBe('https://cdn.example/b.jpg');
  });

  it('resolves a relative og:image against the page it came from', () => {
    const html = '<meta property="og:image" content="/img/dish.jpg" />';
    expect(extractPageImage('https://site.example/recipes/pasta', html)).toBe('https://site.example/img/dish.jpg');
  });

  it('decodes entities in the URL (&amp; in a query string is the common one)', () => {
    const html = '<meta property="og:image" content="https://cdn.example/d.jpg?w=800&amp;h=600" />';
    expect(extractPageImage('https://site.example/r', html)).toBe('https://cdn.example/d.jpg?w=800&h=600');
  });

  it('returns null when the page nominates nothing', () => {
    expect(extractPageImage('https://site.example/r', '<html><head></head></html>')).toBeNull();
  });

  it('rejects anything that is not a real remote image', () => {
    // A cover is stored as a URL string, so a base64 blob must not land in
    // that column — and a model that invents a non-URL must not either.
    expect(absoluteImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(absoluteImageUrl('javascript:alert(1)')).toBeNull();
    expect(absoluteImageUrl('file:///etc/passwd')).toBeNull();
    expect(absoluteImageUrl('not a url')).toBeNull();
    expect(absoluteImageUrl('')).toBeNull();
    expect(absoluteImageUrl(null)).toBeNull();
    expect(absoluteImageUrl(undefined)).toBeNull();
  });

  it('keeps an absolute http(s) URL as-is', () => {
    expect(absoluteImageUrl('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
    expect(absoluteImageUrl('http://cdn.example/a.jpg')).toBe('http://cdn.example/a.jpg');
  });
});
