/** The SmartChef brand mark, as inline SVG so it prints identically on the web,
 *  in Electron and in the Android WebView: print CSS hides every <img> without
 *  `print-image`, strips background images, and an async asset would race the
 *  print dialog. Kept out of <footer>/<header> elements, which print hides. */

const GREEN = '#006C49';

/** Rounded green tile with the chef hat and pot — the app icon (public/chef.svg). */
export function SmartChefMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill={GREEN} />
      <rect x="15" y="32" width="34" height="19" rx="3" fill="#fff" />
      <rect x="13" y="30" width="38" height="5" rx="2.5" fill="#fff" />
      <ellipse cx="12" cy="37" rx="4.5" ry="6" fill="#fff" />
      <ellipse cx="52" cy="37" rx="4.5" ry="6" fill="#fff" />
      <path d="M24 26 L22 18 L26 22 L28 14 L32 22 L36 14 L38 22 L42 18 L40 26" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Quiet watermark for the foot of a printed recipe: icon + name, half transparent. */
export function SmartChefWatermark({ className }: { className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: 0.5 }}>
      <SmartChefMark size={14} />
      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', color: '#27272a' }}>SmartChef</span>
    </span>
  );
}

/** Restrained upscale signature for the head of a printed menu: a single-
 *  weight line drawing of the toque over a spaced serif wordmark, in ink rather
 *  than brand green, at half opacity so it sits behind the dishes. */
export function SmartChefMenuMark({ className }: { className?: string }) {
  return (
    <div className={className} style={{ opacity: 0.5, color: '#1c1917', textAlign: 'center' }}>
      <svg width="34" height="34" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 41 C13 41 10 30 18 27.5 C17 19 27 15 32 20.5 C37 15 47 19 46 27.5 C54 30 51 41 43 41" />
        <path d="M21 41 V50 H43 V41" />
        <path d="M21 45.5 H43" />
        <path d="M27 41 V33 M32 41 V31 M37 41 V33" />
      </svg>
      <div style={{ paddingTop: '3px', fontFamily: 'Georgia, "Times New Roman", serif', fontSize: '9px', letterSpacing: '0.42em', textTransform: 'uppercase', paddingLeft: '0.42em' }}>
        SmartChef
      </div>
    </div>
  );
}
