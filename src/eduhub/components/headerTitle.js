/**
 * headerTitle.js — VT Pass A · pure title resolver for the global Header.
 *
 * Extracted as a standalone, dependency-free module so it can be unit-tested
 * without booting the rest of the Header component (which imports
 * react-router-dom, lucide-react, AuthContext and various PWA / push
 * notification dependencies that would otherwise need to be mocked).
 *
 * The Header component imports `resolveTitle` and `VT_PREFIX` from here.
 * The /game/voice-treasure subtree is isolated to display "Voice Treasure";
 * Lucky Spin titles and every unrelated route title are unchanged.
 */
export const TITLES = {
  "/":            "Dashboard",
  "/library":     "Classroom Library",
  "/portal":      "My Portal",
  "/portal/me":   "My Portal",
  "/game":        "Lucky Spin",
  "/game/play":   "Lucky Spin",
  "/login":       "Sign In",
  "/systemtest":  "System Test",
  "/assistant":   "AI Assistant",
};

export const VT_PREFIX = "/game/voice-treasure";

export function resolveTitle(pathname) {
  if (pathname === VT_PREFIX || pathname.startsWith(VT_PREFIX + "/")) {
    return "Voice Treasure";
  }
  return (
    TITLES[pathname] ||
    Object.entries(TITLES).find(([k]) => k !== "/" && pathname.startsWith(k))?.[1] ||
    "Dashboard"
  );
}
