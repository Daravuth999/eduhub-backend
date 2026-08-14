// useVisualViewportKeyboard.js — reports whether the on-screen software
// keyboard is currently open.
//
// v2 — baseline-tracking instead of comparing window.innerHeight against
// visualViewport.height at the same instant. The original diff-based
// approach silently breaks once the page's viewport meta tag declares
// `interactive-widget=resizes-content` (added alongside this fix to
// solve the "whole page translates upward" bug): with that directive,
// the LAYOUT viewport (window.innerHeight) shrinks in lockstep with the
// VISUAL viewport when the keyboard opens, so their difference stays
// ~0 and the old formula would never detect the keyboard at all.
//
// This version instead remembers the largest visible height seen (the
// "no keyboard" baseline) and flags the keyboard as open whenever the
// current height drops meaningfully below it — which holds true
// regardless of which of the two viewports the browser resizes. The
// baseline re-expands on rotation / resize back up (e.g. keyboard
// closes, or the device rotates), so it never gets stuck low.
//
// Used by AppShell to hide MobileBottomNav while the keyboard is open
// (see App.js) — the fixed bottom nav has nothing useful to show once
// the keyboard covers that part of the screen.
//
// Returns false in non-browser / SSR environments so nothing regresses
// there — desktop already never renders MobileBottomNav (lg:hidden).

import { useEffect, useRef, useState } from "react";

const KEYBOARD_THRESHOLD_PX = 120;

export default function useVisualViewportKeyboard() {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const baselineRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const getHeight = () => {
      const vv = window.visualViewport;
      return vv ? vv.height : window.innerHeight;
    };

    if (baselineRef.current == null) baselineRef.current = getHeight();

    const compute = () => {
      const h = getHeight();
      // Keyboard closing / device rotated taller — raise the baseline
      // back up so a later keyboard-open is measured against the
      // correct "full height", not a stale smaller one.
      if (h > baselineRef.current) baselineRef.current = h;
      const inset = Math.max(0, baselineRef.current - h);
      setIsKeyboardOpen(inset > KEYBOARD_THRESHOLD_PX);
    };
    compute();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", compute);
      vv.addEventListener("scroll", compute);
    } else {
      window.addEventListener("resize", compute);
    }
    return () => {
      if (vv) {
        vv.removeEventListener("resize", compute);
        vv.removeEventListener("scroll", compute);
      } else {
        window.removeEventListener("resize", compute);
      }
    };
  }, []);

  return isKeyboardOpen;
}
