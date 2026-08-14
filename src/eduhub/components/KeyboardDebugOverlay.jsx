// KeyboardDebugOverlay.jsx — on-device diagnostic panel for the
// "keyboard causes the page to translate" investigation.
//
// Renders NOTHING unless the URL contains `?kbdebug=1` (same pattern as
// the existing `?pwa=debug` / `?pwa=reset` kill-switches in
// public/index.html) — completely invisible to every real user, every
// existing test, and every other page. Mounted once in AppShell so it
// can be enabled on any route, but it's most useful on /assistant.
//
// Purpose: tap the composer on a real phone with this panel visible,
// screen-record it, and the exact numbers (not guesses) show what's
// actually happening — which viewport is resizing, whether body is
// actually locked, and where the bottom nav's transform ends up.
import { useEffect, useState } from "react";

function useIsDebugEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    try {
      setEnabled(new URLSearchParams(window.location.search).get("kbdebug") === "1");
    } catch {
      setEnabled(false);
    }
  }, []);
  return enabled;
}

function readSnapshot() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const nav = document.querySelector('nav[aria-label="Primary"]');
  const navStyle = nav ? getComputedStyle(nav) : null;
  const activeTag = document.activeElement ? document.activeElement.tagName : "(none)";
  return {
    innerHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    vvHeight: vv ? Math.round(vv.height) : null,
    vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
    vvScale: vv ? vv.scale : null,
    bodyPosition: document.body.style.position || "(static)",
    bodyTop: document.body.style.top || "(none)",
    bodyOverflow: document.body.style.overflow || "(visible)",
    bodyRectTop: Math.round(document.body.getBoundingClientRect().top),
    navTransform: navStyle ? navStyle.transform : "(no nav found)",
    activeTag,
  };
}

export default function KeyboardDebugOverlay() {
  const enabled = useIsDebugEnabled();
  const [snap, setSnap] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const update = () => setSnap(readSnapshot());
    update();
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    const interval = window.setInterval(update, 400);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.clearInterval(interval);
    };
  }, [enabled]);

  if (!enabled || !snap) return null;

  const row = (label, value) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span>{String(value)}</span>
    </div>
  );

  return (
    <div
      data-testid="keyboard-debug-overlay"
      style={{
        position: "fixed",
        top: "env(safe-area-inset-top, 0px)",
        left: 4,
        right: 4,
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.88)",
        color: "#7fffb0",
        font: "10.5px/1.4 ui-monospace, 'JetBrains Mono', monospace",
        padding: "6px 8px",
        borderRadius: 8,
        pointerEvents: "none",
      }}
    >
      {row("innerHeight", snap.innerHeight)}
      {row("scrollY", snap.scrollY)}
      {row("vv.height", snap.vvHeight)}
      {row("vv.offsetTop", snap.vvOffsetTop)}
      {row("vv.scale", snap.vvScale)}
      {row("body.position", snap.bodyPosition)}
      {row("body.top", snap.bodyTop)}
      {row("body.overflow", snap.bodyOverflow)}
      {row("body rect.top", snap.bodyRectTop)}
      {row("nav transform", snap.navTransform)}
      {row("active element", snap.activeTag)}
    </div>
  );
}
