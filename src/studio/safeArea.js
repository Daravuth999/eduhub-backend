/**
 * safeArea.js — the ONE shared iOS safe-area convention for every Author
 * Studio root/full-screen header.
 *
 * Author Studio (`/studio`) renders full-bleed, OUTSIDE AppShell, by
 * explicit design (own Google OAuth — see App.js's "/studio — full-bleed
 * Author Studio" comment). That means none of its headers automatically
 * inherit AppShell's Header.jsx, which already handles the Dynamic
 * Island/notch via `paddingTop: "max(0px, env(safe-area-inset-top))"`.
 * Every Author Studio header — the root StudioPage shell AND the two
 * full-screen production overlays (ProductionStudio, SyncReviewStudio) —
 * must apply this explicitly, and must all agree on the same formula so a
 * future header doesn't silently drift from the others. Import
 * `studioSafeAreaTop(basePx)` rather than inlining `env(safe-area-inset-
 * top)` again.
 *
 * `basePx` is the header's normal (non-inset) vertical padding — the
 * function returns whichever is larger: that plain padding (devices/
 * browsers with no inset, where env() resolves to 0) or the real inset
 * plus that same padding (notched/Dynamic-Island devices). Requires
 * `viewport-fit=cover` on the viewport meta tag (already set in
 * public/index.html) — without it, env(safe-area-inset-*) always
 * resolves to 0 and this degrades to a no-op.
 */
export function studioSafeAreaTop(basePx) {
  return `max(${basePx}px, calc(env(safe-area-inset-top) + ${basePx}px))`;
}

export function studioSafeAreaBottom(basePx) {
  return `max(${basePx}px, calc(env(safe-area-inset-bottom) + ${basePx}px))`;
}
