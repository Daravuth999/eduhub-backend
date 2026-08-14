/**
 * bottomNavActive.js — VT Pass A · pure active-state resolver for the
 * mobile bottom navigation.
 *
 * Standalone module so it can be unit-tested in isolation. The Voice
 * Treasure subtree (/game/voice-treasure/*) must have NO active bottom-nav
 * item, while every other route preserves the prior prefix-match behavior
 * (Home root, Library prefix, Spin prefix, Portal dual-route).
 */
export const VT_PREFIX = "/game/voice-treasure";

export function isActiveForPath(it, pathname) {
  if (pathname === VT_PREFIX || pathname.startsWith(VT_PREFIX + "/")) {
    return false;
  }
  if (it && it.key === "portal") {
    return pathname === "/portal" || pathname.startsWith("/portal/");
  }
  return it && it.to === "/"
    ? pathname === "/"
    : (it && (pathname === it.to || pathname.startsWith(it.to + "/")));
}
