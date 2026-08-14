/**
 * interactionAccessibility.js — Signature Smart Interactive Book,
 * Checkpoint 1: shared accessibility helpers so none of the nine
 * interaction components need to create its own aria-live region or
 * duplicate testid/aria-attribute conventions.
 *
 * The announcer is a SINGLETON PER READER INSTANCE (created lazily on first
 * use, removed on `teardownAnnouncer()`), not a module-level node that lives
 * forever across page navigations.
 */
let _liveRegionEl = null;

function _ensureLiveRegion() {
  if (_liveRegionEl && document.body.contains(_liveRegionEl)) return _liveRegionEl;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("data-testid", "bf-interaction-announcer");
  el.style.position = "absolute";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.overflow = "hidden";
  el.style.clipPath = "inset(50%)";
  document.body.appendChild(el);
  _liveRegionEl = el;
  return el;
}

/** announce(message) — feedback for correctness/consequence/completion that
 * must never depend on color alone. Safe to call many times; the region is
 * created once and reused. */
export function announce(message) {
  if (!message) return;
  try {
    const el = _ensureLiveRegion();
    el.textContent = "";
    // Force a DOM mutation even for an identical consecutive message.
    window.requestAnimationFrame(() => { el.textContent = message; });
  } catch {
    // Accessibility is best-effort — never throws into the reading flow.
  }
}

/** teardownAnnouncer() — removes the singleton node (call on Reader unmount
 * in a later checkpoint once a component actually mounts this runtime). */
export function teardownAnnouncer() {
  if (_liveRegionEl && _liveRegionEl.parentNode) {
    _liveRegionEl.parentNode.removeChild(_liveRegionEl);
  }
  _liveRegionEl = null;
}

/** Consistent data-testid builder so component tests never hand-roll a
 * different naming convention per interaction type. */
export function interactionTestId(type, id, part) {
  return part ? `bf-${type}-${id}-${part}` : `bf-${type}-${id}`;
}
