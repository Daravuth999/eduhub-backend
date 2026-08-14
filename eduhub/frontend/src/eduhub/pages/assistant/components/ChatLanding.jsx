// ChatLanding.jsx — premium landing for Free Chat.
//
// Presentational only — reads NO API and NO AuthContext. Parent
// (FreeChatPanel) passes the student's first name, the cards to show,
// the disabled flag, and onPick callback.
//
// v5 — "three suggested prompts", not six. FreeChatPanel now passes
// only the first 3 of its 6 starter categories (`STARTER_CARDS.slice(0,
// 3)`), and this renders them as a single calm vertical column instead
// of a 2-column grid (which left an awkward empty cell for any count
// that isn't even). Every other category is still one tap away via the
// mode chips shown just above this — nothing is actually removed, only
// how many are pinned to the empty-state screen. Tiles render via
// CategoryCard (soft matte surface, no harsh border) and preserve the
// ai-coach-starter-<key> data-testid contract.

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import CategoryCard from "./CategoryCard";
import { EASE, DURATION } from "../motion";

export default function ChatLanding({
  firstName,
  cards,
  onPick,
  disabled,
}) {
  const reduced = useReducedMotion();
  const safeFirst = firstName && firstName !== "friend" ? firstName : "";

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : DURATION, ease: EASE }}
      data-testid="ai-coach-landing"
    >
      <div
        className="ai-landing-greet"
        data-testid="ai-coach-landing-greeting"
      >
        <Sparkles className="ai-landing-greet__icon" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div style={{ fontWeight: 800 }}>
            {safeFirst
              ? `What would you like to practice today, ${safeFirst}?`
              : "What would you like to practice today?"}
          </div>
          <div className="ai-landing-greet__sub">
            Pick a coach card, or just type a question below.
          </div>
        </div>
      </div>

      <div
        className="grid grid-cols-1 gap-2.5"
        data-testid="ai-coach-starter-cards"
      >
        {cards.map((c) => (
          <CategoryCard
            key={c.key}
            card={c}
            disabled={disabled}
            onSelect={onPick}
            testId={`ai-coach-starter-${c.key}`}
          />
        ))}
      </div>
    </motion.div>
  );
}
