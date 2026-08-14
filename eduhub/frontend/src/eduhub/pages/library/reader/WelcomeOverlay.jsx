import { useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import "./welcome-overlay.css";

import sparklesData from "./lotties/sparkles.json";
import auroraData   from "./lotties/aurora.json";
import bloomData    from "./lotties/bloom.json";
import pageTurnData from "./lotties/page-turn.json";

const LOTTIE_MAP = { sparkles: sparklesData, aurora: auroraData, bloom: bloomData, pageTurn: pageTurnData };

const TIER = {
  free:     { eyebrow: "Welcome",         accent: "#c89b6a", bg: "wo-bg-free",     lotties: ["pageTurn","sparkles"] },
  standard: { eyebrow: "Your lesson",     accent: "#d4af37", bg: "wo-bg-standard", lotties: ["pageTurn","sparkles","bloom"] },
  premium:  { eyebrow: "Premium content", accent: "#f5d97a", bg: "wo-bg-premium",  lotties: ["pageTurn","aurora","bloom","sparkles"] },
  limited:  { eyebrow: "Limited edition", accent: "#9ad4ff", bg: "wo-bg-limited",  lotties: ["pageTurn","aurora","sparkles","bloom"] },
};

function resolveTier(student, book) {
  const raw = (book?.tier || book?.badge || student?.tier || student?.plan || "free").toString().toLowerCase();
  if (TIER[raw]) return raw;
  if (raw.includes("prem")) return "premium";
  if (raw.includes("limit")) return "limited";
  if (raw.includes("stand") || raw.includes("plus")) return "standard";
  return "free";
}

function isFirstPage(p) {
  if (p == null) return true;
  const n = Number(p);
  return Number.isNaN(n) ? String(p).trim() === "1" : (n === 1 || n === 0);
}

/* Per-book session-scoped dismissal flag. Once the user has dismissed
 * the welcome overlay for a given book in the current PWA session, the
 * overlay must never re-mount for the same book - this kills the
 * "Begin Reading -> overlay reappears" loop caused by async book load
 * mutating book?.slug / book?.title after the first dismissal. */
const WO_DISMISS_PREFIX = "eduhub_welcome_dismissed_v1_";
function woKey(book) {
  return WO_DISMISS_PREFIX + (book?.slug || book?.title || "_");
}
function woIsDismissed(book) {
  try { return sessionStorage.getItem(woKey(book)) === "1"; } catch (_) { return false; }
}
function woMarkDismissed(book) {
  try { sessionStorage.setItem(woKey(book), "1"); } catch (_) { /* ignore */ }
}

/* ── Lottie layer — loads lottie via script tag (CRA-safe, no dynamic import) ── */
function LottieLayer({ name, className, loop = true, speed = 1 }) {
  const ref = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    let dead = false;

    const run = (lottie) => {
      if (dead || !ref.current || !lottie) return;
      const a = lottie.loadAnimation({
        container: ref.current,
        renderer: "svg", loop, autoplay: true,
        animationData: LOTTIE_MAP[name],
        rendererSettings: { preserveAspectRatio: "xMidYMid slice" },
      });
      a.setSpeed(speed);
      animRef.current = a;
    };

    // If lottie already on window (script already loaded)
    if (window.lottie) { run(window.lottie); return; }

    // Inject script once
    const existing = document.getElementById("wo-lottie-cdn");
    if (existing) {
      existing.addEventListener("load", () => run(window.lottie));
    } else {
      const s = document.createElement("script");
      s.id = "wo-lottie-cdn";
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js";
      s.onload = () => run(window.lottie);
      s.onerror = () => {}; // CSS fallback still shows
      document.head.appendChild(s);
    }

    return () => {
      dead = true;
      try { animRef.current?.destroy(); } catch (_) {}
    };
  }, [name, loop, speed]);

  return <div ref={ref} className={`wo-ll ${className}`} aria-hidden="true" />;
}

/* ══════════════════════════════════════════════════════════════════════ */
export default function WelcomeOverlay({ student, book, currentPage }) {
  const tier   = useMemo(() => resolveTier(student, book), [student, book]);
  const cfg    = TIER[tier];
  const onPage1 = isFirstPage(currentPage);

  const [mounted,  setMounted]  = useState(onPage1 && !woIsDismissed(book));
  const [leaving,  setLeaving]  = useState(false);
  const fireKey = useRef(0);

  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const HOLD = reduced ? 1500 : 2800;
  const EXIT = reduced ? 200  : 500;

  useEffect(() => {
    if (woIsDismissed(book)) { setMounted(false); return; }
    if (onPage1) { fireKey.current += 1; setLeaving(false); setMounted(true); }
    else         { setMounted(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPage1, book?.slug, book?.title]);

  useEffect(() => {
    if (!mounted || leaving) return;
    const t = setTimeout(() => { woMarkDismissed(book); setLeaving(true); }, HOLD);
    const k = (e) => { if (["Escape"," ","Enter"].includes(e.key)) { woMarkDismissed(book); setLeaving(true); } };
    window.addEventListener("keydown", k);
    return () => { clearTimeout(t); window.removeEventListener("keydown", k); };
  }, [mounted, leaving, HOLD, book]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setMounted(false), EXIT);
    return () => clearTimeout(t);
  }, [leaving, EXIT]);

  if (!mounted || typeof document === "undefined") return null;

  const name  = student?.displayName || student?.name || student?.firstName || student?.studentId || "Reader";
  const title = book?.title || "your book";
  const author = book?.author || book?.authorName;

  return createPortal(
    <div
      key={fireKey.current}
      className={`wo-root ${cfg.bg} ${leaving ? "wo-out" : "wo-in"} ${reduced ? "wo-rm" : ""}`}
      role="dialog"
      aria-label={`Welcome ${name}, opening ${title}`}
      style={{ "--acc": cfg.accent }}
      onClick={() => { woMarkDismissed(book); setLeaving(true); }}
    >
      {/* Lottie layers */}
      <div className="wo-lottie-stack" onClick={e => e.stopPropagation()}>
        {cfg.lotties.includes("aurora")    && <LottieLayer name="aurora"   className="wo-aurora-l"   speed={0.5} />}
        {cfg.lotties.includes("bloom")     && <LottieLayer name="bloom"    className="wo-bloom-l"    speed={0.8} />}
        {cfg.lotties.includes("sparkles")  && <LottieLayer name="sparkles" className="wo-sparkles-l" speed={1.0} />}
        {cfg.lotties.includes("pageTurn")  && <LottieLayer name="pageTurn" className="wo-pageturn-l" loop={false} speed={1.2} />}
      </div>

      {/* Always-visible CSS ambient (even if Lottie CDN fails) */}
      <div className="wo-ambient" aria-hidden="true" />

      {/* Card */}
      <div className="wo-card" onClick={e => e.stopPropagation()}>
        <div className="wo-eyebrow">{cfg.eyebrow}</div>
        <h1 className="wo-name">{name}</h1>
        <div className="wo-title">"{title}"</div>
        {author && <div className="wo-author">by {author}</div>}
        <button className="wo-btn" type="button" onClick={() => { woMarkDismissed(book); setLeaving(true); }}>
          Begin reading
        </button>
        <p className="wo-hint">Tap anywhere · Esc to skip</p>
      </div>
    </div>,
    document.body
  );
}
