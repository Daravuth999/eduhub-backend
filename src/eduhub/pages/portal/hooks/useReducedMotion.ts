import { useEffect, useState } from "react";

function supportsMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/** Listens to `prefers-reduced-motion` and reflects it in state. Safe in
 * any environment lacking `matchMedia` (older WebViews, some test
 * environments, SSR) — falls back to `false` (motion enabled) rather
 * than throwing. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (!supportsMatchMedia()) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (!supportsMatchMedia()) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fn = () => setReduced(mql.matches);
    mql.addEventListener?.("change", fn);
    return () => mql.removeEventListener?.("change", fn);
  }, []);
  return reduced;
}
