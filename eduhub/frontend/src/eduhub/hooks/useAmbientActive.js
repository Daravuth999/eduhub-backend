// useAmbientActive.js — RC2.5 Motion System: the single gate every
// continuous/looping ambient animation (breathing glow, light sweep,
// sparkle twinkle, gentle float) on the Dashboard checks before running.
//
// "Active" means all three are true:
//   1. the element is actually on-screen (IntersectionObserver)
//   2. the browser tab is visible (Page Visibility API)
//   3. the OS is not requesting reduced motion
//
// Framer Motion's shell-level MotionConfig(reducedMotion="user") already
// neutralizes transform-based `animate` (x/y/scale/rotate) automatically,
// but does NOT cover other animated properties these ambient effects use
// (opacity loops, boxShadow, backgroundPosition, filter) — so this hook
// checks reduced-motion itself via framer-motion's own useReducedMotion(),
// making it the one place every ambient effect can rely on for a complete,
// correct gate rather than each component re-deriving it.
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

export default function useAmbientActive() {
  const ref = useRef(null);
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVis = () => setTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { ref, active: inView && tabVisible && !reducedMotion };
}
