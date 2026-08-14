// StatusPills.jsx — v5 quiet meta line for the AI Assistant header.
//
// Surfaces ONLY real runtime data:
//   • student first-name               ← AuthContext (student.name)
//   • available points                 ← AuthContext (student.portalPoints ?? points)
//   • answer cost                      ← getAssistantConfig().config.cost_points
//
// v5 — "This is not a dashboard" pass. Two changes from v4:
//
//   1. The live/paused status segment is gone. It was a genuine
//      duplicate: PausedStateCard already renders a full, unmissable
//      banner ("AI Assistant is paused" / "Speech Missions are
//      locked") driven by the exact same enabled/missions_enabled
//      flags FreeChatPanel and SpeechCoachPanel fetch independently.
//      A quiet ambient "AI live" dot next to the greeting told the
//      user nothing they weren't told twice elsewhere, so the
//      duplicate config fetch that only fed that dot (getVoiceConfig
//      for missions_enabled) is removed too — it rendered nothing else.
//
//   2. Once a real conversation is under way, the parent (Assistant.jsx)
//      stops mounting this component at all — wrapped in AnimatePresence
//      so it fades/slides away instead of vanishing abruptly — reclaiming
//      the row for the conversation instead of leaving an empty
//      placeholder. That's why the exit transition below matters: this
//      component only ever gets removed while visible, never toggled by
//      an internal flag.
//
// This component is PRESENTATIONAL. It reads live data via the same
// helpers as before, but it never mutates state, never touches API
// contracts, never charges points, and never invents levels/streaks.
//
// data-testid contract (preserved verbatim so existing selectors keep
// matching this node):
//   ai-assistant-personal-hero
//   ai-assistant-hero-avatar
//   ai-assistant-hero-greeting
//   ai-assistant-hero-points          (when points are known)
//   ai-assistant-hero-points-loading  (until points arrive)
//   ai-assistant-hero-cost

import React, { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Coins, Sparkles } from "lucide-react";
import { useAuth } from "../../../context/AuthContext";
import { getAssistantConfig } from "../../../lib/aiAssistantApi";
import { EASE, DURATION } from "../motion";

function pickFirstName(student) {
  const raw = String(student?.name || student?.studentId || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/)[0] || "";
  return first.replace(/[*_`<>]/g, "");
}

// Return a finite number or null — never coerce undefined → 0.
function readLivePoints(student) {
  if (!student || typeof student !== "object") return null;
  const candidates = [student.portalPoints, student.points];
  for (const v of candidates) {
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export default function StatusPills() {
  const { student, isBootstrapping } = useAuth();
  const reduced = useReducedMotion();

  const firstName = pickFirstName(student);
  const livePoints = readLivePoints(student);
  const pointsKnown = livePoints !== null;

  const [costPoints, setCostPoints] = useState(null);

  useEffect(() => {
    let dead = false;
    if (isBootstrapping) return undefined;
    (async () => {
      try {
        const r = await getAssistantConfig();
        const cfg = (r && (r.config || r)) || null;
        if (dead || !cfg) return;
        const cost = Number(cfg.cost_points);
        if (Number.isFinite(cost) && cost >= 0) setCostPoints(cost);
      } catch {
        /* keep defaults */
      }
    })();
    return () => { dead = true; };
  }, [isBootstrapping]);

  return (
    <motion.header
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: reduced ? 0 : DURATION, ease: EASE }}
      data-testid="ai-assistant-personal-hero"
      className="ai-shell-meta"
      aria-label="Coach status"
    >
      <span data-testid="ai-assistant-hero-avatar" className="ai-shell-meta__identity">
        <span data-testid="ai-assistant-hero-greeting" className="ai-shell-meta__greeting">
          {isBootstrapping || !firstName ? "Hi there" : `Hi, ${firstName}`}
        </span>
      </span>

      <span className="ai-shell-meta__sep" aria-hidden="true">·</span>

      {pointsKnown ? (
        <span data-testid="ai-assistant-hero-points" className="ai-shell-meta__points">
          <Coins className="ai-shell-meta__icon" aria-hidden="true" />
          <span className="tabular-nums">{Number(livePoints).toLocaleString()}</span> pts
        </span>
      ) : (
        <span data-testid="ai-assistant-hero-points-loading" className="ai-shell-meta__muted">
          <Coins className="ai-shell-meta__icon" aria-hidden="true" />
          … pts
        </span>
      )}

      {costPoints !== null && (
        <>
          <span className="ai-shell-meta__sep" aria-hidden="true">·</span>
          <span data-testid="ai-assistant-hero-cost" className="ai-shell-meta__muted">
            <Sparkles className="ai-shell-meta__icon" aria-hidden="true" />
            <span className="tabular-nums">{costPoints}</span>/answer
          </span>
        </>
      )}
    </motion.header>
  );
}
