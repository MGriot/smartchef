# Is SmartChef usable on Android TV?

**Verdict: no, and it would not install.** Nothing here is hard to fix in
principle, but "runs on a TV" and "usable from a remote" are two different
projects, and only the first is small.

Assessed against the 1.5.1 tree. No app code was changed for this document.

---

## What a TV actually requires

Android TV asks for three separate things, and the app currently provides
none of them:

| Requirement | Status |
|---|---|
| Declared as a TV app so the Play Store and the launcher will list it | Missing |
| Operable with a D-pad — up/down/left/right, select, back — and nothing else | Missing |
| Readable and reachable at 10 feet, with visible focus | Partly present |

---

## 1. It will not install or appear on a TV

`frontend/android/app/src/main/AndroidManifest.xml` is the stock Capacitor
manifest. A TV launcher will not show the app at all, and Play would reject
a TV listing:

- no `<uses-feature android:name="android.software.leanback" android:required="false" />`
- no `<category android:name="android.intent.category.LEANBACK_LAUNCHER" />` on
  the activity — only the ordinary `LAUNCHER` category
- no `<uses-feature android:name="android.hardware.touchscreen" android:required="false" />`,
  so the app implicitly demands a touchscreen, which a TV does not have
- no `android:banner` on `<application>`, which the TV home screen uses in
  place of an icon

This part is genuinely cheap — four manifest lines and one 320×180 banner
asset. It is also the *only* cheap part, and doing it alone would ship
something installable and unusable, which is worse than not shipping it.

## 2. A remote cannot drive the interface

There is no focus management anywhere in `frontend/src`:

- **zero** `tabIndex` attributes in the entire source tree
- the only arrow-key handler in the app is `components/Autocomplete.tsx:98`,
  for moving the highlight in a suggestion list
- six `<div onClick=…>` elements across the pages are not focusable and
  cannot be activated by Enter or Space at all
- no roving-tabindex anywhere, so a grid of recipe cards is walked one card
  at a time in DOM order rather than in the two dimensions it is drawn in

What a D-pad would actually get is the browser's own sequential focus
order. That is not nothing — most controls are real `<button>` and
`<input>` elements, so they *are* reachable — but reaching the sixth card
in the third row means pressing down about twenty times.

Specific screens that would be unusable rather than merely tedious:

| Screen | Why |
|---|---|
| Atlas / recipe map | Leaflet's own keyboard panning is not enabled, and the pins are SVG markers with no tab stop. Nothing on the map can be reached. |
| Servings slider, and the three other `type="range"` inputs | Reachable and technically operable (arrow keys are native), but arrow keys are also how you leave the control, so focus gets trapped on it. |
| Export / collections popovers | Opened from a button, but the popover contents are not focus-trapped, so the next Down press walks behind the open menu. |
| Recipe card grids | Sequential-only, as above. |

**Correction to a common first impression:** `components/Modal.tsx` is
better than the rest. It already stacks dialogs, closes the top one on
Escape (`:82-87`), focuses the first control on open and restores focus to
the opener on close (`:116-139`). It has no Tab cycle trap, but it is the
one component that would not need rewriting from scratch.

## 3. Focus is visible, but only just

`src/index.css` defines one global indicator:

```css
:focus-visible { outline: 2px solid rgb(var(--color-primary)); outline-offset: 2px; }
```

That is real and it now follows the chosen accent scheme (it was a
hard-coded green hex until this release). At 10 feet, though, a 2px outline
is close to invisible — TV interfaces conventionally scale or tint the
focused element itself, not just ring it.

Text sizing is a smaller problem than it looks: the app is already
responsive and a TV reports a large viewport, so it would render its
desktop layout. That layout assumes a mouse pointer, not a 10-foot reading
distance, but it is at least not broken.

---

## Effort, if it were to be done

Three phases, in the only order that makes sense:

1. **Manifest and banner** — half a day. Makes it installable and listed.
   Worthless on its own; do not ship it alone.
2. **Focus foundations** — roughly a week. A roving-tabindex helper for
   card grids and chip rows, a Tab cycle trap in `Modal.tsx`, converting
   the six clickable `<div>`s to buttons, an escape hatch for the range
   inputs, and a much louder focus style behind a "TV mode" media query.
   This is the phase that decides whether the thing is usable.
3. **Screen-by-screen** — two to three weeks. Every page walked with a
   D-pad and fixed: the map (either keyboard controls or a list fallback),
   cook mode, the editor, the import flow.

An honest lower bound for something worth releasing is **three to four
weeks**, and the second phase touches nearly every component — which is
why it was kept out of the 1.6.0 work rather than bolted onto it.

## Recommendation

Do not ship partial TV support. If a TV is wanted, the phase that matters
is the second one, and its output is worth having regardless: roving
tabindex, focus traps and visible focus are plain keyboard accessibility,
and they improve the desktop app for anyone who does not use a mouse.

A cheaper alternative worth weighing first: the app is already a web app
served over the network. Casting a browser tab, or opening the existing
Tailscale-reachable instance in the TV's own browser, gets a recipe onto a
television today with no code at all — badly, but today.
