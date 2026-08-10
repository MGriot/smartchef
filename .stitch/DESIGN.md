# Design System: SmartChef Culinary Atelier

## 1. Visual Theme & Atmosphere
A restrained, gallery-airy interface with confident structured layouts. The atmosphere is clinical yet warm — like a well-lit architecture studio or a professional digital kitchen. It uses clean lines, distinct spatial zones, and high-contrast typography instead of heavy borders and shadows to establish hierarchy.

## 2. Color Palette & Roles
- **Canvas Shell** (`#F3F4F1`) — Primary background surface for sidebars and auxiliary zones.
- **Pure Canvas** (`#FFFFFF`) — Main content background, card fills.
- **Deep Emerald** (`#006C49`) — Primary accent, logos, active states, buttons.
- **Emerald Tint** (`#D1FAE5` or `rgba(16, 185, 129, 0.1)`) — Subtle background for active nodes or success tags.
- **Charcoal Ink** (`#18181A`) — Primary text, Zinc-950 depth for high readability.
- **Muted Steel** (`#71717A`) — Secondary text for metadata, descriptions, and subtle icons.
- **Whisper Border** (`rgba(226, 232, 240, 0.6)`) — Used sparingly for structural 1px separations (e.g. under top nav).

## 3. Typography Rules
- **Display:** `Manrope` — Confident, tight-tracking for all Section Headers, Recipe Titles, and Logo.
- **Body & Metadata:** `Inter` — Highly legible, relaxed leading for ingredients, steps, tags, and small UI copy.
- **Banned:** Generic system fonts for titles, pure black colored text, excessive serif fonts in dashboard panels.

## 4. Component Stylings
* **Buttons/Pills:** Pill-shaped (fully rounded) buttons. Deep Emerald for primary CTA. Subtle gray or Emerald Tint for secondary filters. No outer glows.
* **Cards:** Clean rectangles with subtle border radius (`0.5rem` to `1rem`). Soft diffused shadow only on hover, or an extremely light ambient shadow (`rgba(0,0,0,0.03)`). High visual separation achieved through negative space rather than heavy borders.
* **Images:** Full-bleed inside their containers, sharp or very subtle rounded edges. Often embedded with "Smart Tags" floating organically over the top left.
* **Sidebar:** Flat structural zone with off-white/gray background distinct from the pure white main content. Navigation items are clean, utilizing simple left-aligned icons and text without boxed containers unless active.
* **Top Navigation:** Minimalist, integrated seamlessly into the top of the canvas, utilizing high-contrast green text or underline for active state.

## 5. Layout Principles
- **Spatial Separation:** Strong negative space between sidebar and main content.
- **Grid Systems:** Strict asymmetric or 3-column equal grid for galleries. No flexbox percentage hacks.
- **Navigation Placement:** In comprehensive views (Gallery), the App brand and sidebar tools live on the left, while contextual navigation lives at the top of the main content. In focused views (Recipe Detail), the sidebar collapses to afford maximum width for content, merging the brand into the top nav.
- **Hero Image (Recipe Detail):** Large, cinematic banner image establishing the dish before diving into the two-column "Method vs Ingredients" layout.

## 6. Motion & Interaction
- Fast, tactile micro-interactions on hover for recipe cards (scale up image slightly).
- Hover states on navigation elements change text color to primary accent without bulky background shifts outside of the sidebar.
- No heavy bouncy animations; focus on immediate, crisp responses.

## 7. Anti-Patterns (Banned)
- NEVER use pure black (`#000000`).
- NEVER use heavy box-shadows or 3D skeuomorphic depths.
- NEVER use generic 3-column layouts where an asymmetric option is better, though standard item grids for Recipe Galleries are permitted.
- NEVER overlap structural boundaries with floating elements (except curated "tags" on images).
- NEVER use thick borders (use padding and background color differences instead).
- NO glowing neon accents or purple/blue palettes.
