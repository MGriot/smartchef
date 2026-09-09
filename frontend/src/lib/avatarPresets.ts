// ════════════════════════════════════════════════════════════════════════
// SmartChef — Avatar presets
// Adaptive to whatever's in the folder — adding/removing a file here
// changes the preset grid with no code change needed. Mixed formats (the
// original hand-drawn SVGs alongside newer photographic JPEGs) on purpose —
// both are valid presets, not one replacing the other. Shared by Login.tsx
// (account creation) and Account.tsx (editing an existing profile) so both
// offer the same picker instead of one falling back to a bare URL input.
// ════════════════════════════════════════════════════════════════════════

const avatarModules = import.meta.glob('../assets/avatars/*.{svg,jpg,jpeg,png}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const AVATAR_PRESETS = Object.keys(avatarModules)
  .sort()
  .map((path) => avatarModules[path]);

export const DEFAULT_AVATAR = AVATAR_PRESETS[0] ?? '';
