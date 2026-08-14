import React from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import AppStoreTile from "./AppStoreTile";
import { useAuth } from "../context/AuthContext";
import { shouldShowVoiceTreasureTile } from "../pages/game/voice-treasure/homeTile";
import {
  BookIcon,
  ChartIcon,
  CoinIcon,
  BotIcon,
  MicIcon,
  TreasureIcon,
} from "./TileIcons";

/**
 * LottieTileGrid — v12 (audit-clean rebuild, Feb 2026)
 *
 * One tile per ACTUAL original feature route. No fabricated buttons.
 * Mirrors the destinations from the previous QuickAccessGrid (v6) and
 * FeaturedFeatures, so navigation/auth flow is preserved exactly:
 *
 *   /library     — Classroom Library         (auth-gated route)
 *   /portal      — My Portal (public landing) → /portal/me requires auth
 *   /game        — Lucky Spin (public landing) → /game/play requires auth
 *   /assistant   — AI Assistant              (auth-gated route)
 *   /systemtest  — Speaking System Test      (auth-gated route)
 *
 * Removed (these were NEVER separate buttons):
 *   ✗ "Top 5 Champions"  — was an inline strip
 *   ✗ "Notifications"    — handled by header bell + push opt-in
 *   ✗ "Author Studio"    — teacher-only feature, removed from app per spec
 *
 * Auth handling = ORIGINAL behavior (untouched):
 *   - Public landings (/portal, /game) work without login
 *   - Protected routes pass through ProtectedRoute (unchanged) which
 *     redirects to /login?redirect=<path>
 *   - No extra in-grid login overlay
 */

const TILES = [
  { key: "library",     title: "Classroom Library", subtitle: "បណ្ណាល័យថ្នាក់រៀន", paletteKey: "sky",     Icon: BookIcon,  href: "/library"   },
  { key: "portal",      title: "My Portal",         subtitle: "ផ្ទាំងផ្ទាល់ខ្លួន",     paletteKey: "violet",  Icon: ChartIcon, href: "/portal"    },
  { key: "spin",        title: "Lucky Spin",        subtitle: "កង់សំណាង",              paletteKey: "coral",   Icon: CoinIcon,  href: "/game"      },
  { key: "assistant",   title: "AI Assistant",      subtitle: "Personal English Coach", paletteKey: "emerald", Icon: BotIcon,   href: "/assistant" },
  { key: "systemtest",  title: "System Test",       subtitle: "ការប្រឡងនិយាយ",          paletteKey: "amber",   Icon: MicIcon,   href: "/systemtest"},
];

export default function LottieTileGrid() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  // Voice Treasure tile is shown ONLY when the student-safe public config
  // reports the feature available for this student. The original five tiles
  // are never affected by this check.
  const [vtAvailable, setVtAvailable] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    if (!isAuthenticated) { setVtAvailable(false); return; }
    const base = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
    let auth = {};
    try {
      const t = localStorage.getItem("student_session_token");
      if (t) auth = { Authorization: `Bearer ${t}` };
    } catch { /* noop */ }
    fetch(`${base}/api/voice-treasure/config-public`, {
      credentials: "include",
      headers: { ...auth },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => { if (alive) setVtAvailable(shouldShowVoiceTreasureTile(cfg, true)); })
      .catch(() => { if (alive) setVtAvailable(false); });
    return () => { alive = false; };
  }, [isAuthenticated]);

  // Part 1 (Portal Auth-Aware Nav fix) — when the student taps "My
  // Portal", route them to the PRIVATE dashboard (/portal/me) if
  // they're already authenticated.  Logged-out users go through
  // /login with /portal/me preserved as the post-login redirect so
  // they land directly on the evaluation dashboard after sign-in.
  // Every other tile keeps the ORIGINAL behavior (ProtectedRoute does
  // the auth gating downstream).
  const resolveHref = (t) => {
    if (t.key === "portal") {
      return isAuthenticated ? "/portal/me" : "/login?redirect=/portal/me";
    }
    return t.href;
  };

  return (
    <section
      className="my-8"
      aria-label="Quick access tiles"
      data-testid="lottie-tile-grid"
    >
      <div className="px-2 mb-4 flex items-baseline justify-between">
        <h2
          className="font-display text-lg sm:text-xl font-extrabold tracking-tight"
          style={{ color: "rgb(var(--bgfx-ink))" }}
        >
          Explore
        </h2>
        <span
          className="font-khmer text-sm"
          style={{ color: "rgb(var(--bgfx-ink-mute))" }}
        >
          រុករកមុខងារ
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {TILES.map((t, i) => (
          <motion.div
            key={t.key}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.04 * i, ease: [0.34, 1.4, 0.64, 1] }}
            className={i === 4 ? "col-span-2" : ""}
          >
            <AppStoreTile
              title={t.title}
              subtitle={t.subtitle}
              paletteKey={t.paletteKey}
              Icon={t.Icon}
              testId={`tile-${t.key}`}
              onClick={() => navigate(resolveHref(t))}
            />
          </motion.div>
        ))}
        {vtAvailable && (
          <motion.div
            key="voicetreasure"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.24, ease: [0.34, 1.4, 0.64, 1] }}
            className="col-span-2"
          >
            <AppStoreTile
              title="Voice Treasure"
              subtitle="Speak · Discover · Grow"
              paletteKey="violet"
              Icon={TreasureIcon}
              testId="tile-voicetreasure"
              onClick={() => navigate("/game/voice-treasure")}
            />
          </motion.div>
        )}
      </div>
    </section>
  );
}
