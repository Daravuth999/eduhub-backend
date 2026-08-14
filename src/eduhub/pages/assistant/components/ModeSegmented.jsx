// ModeSegmented.jsx — premium segmented pill switch for the
// Assistant page top-level mode selector (Speech Missions / Free Chat).
//
// PRESENTATIONAL ONLY. The parent (Assistant.jsx) owns tab state and
// the tab-change callback. This component never triggers business
// logic and preserves the existing data-testid contract:
//
//   ai-assistant-tabs
//   ai-assistant-tab-missions
//   ai-assistant-tab-chat
//
// The visual design is a matte "segmented control" pill with an
// animated indicator behind the active tab — no heavy neon border, no
// bulky hero-card feel. Fully adaptive to day/night via the shared
// tokens defined in assistant-premium.css.

import React, { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Mic2, MessageSquare } from "lucide-react";

const TABS = [
  { key: "missions", label: "Speech Missions", Icon: Mic2 },
  { key: "chat",     label: "Free Chat",       Icon: MessageSquare },
];

export default function ModeSegmented({ tab, onChange }) {
  const reduced = useReducedMotion();
  const activeIndex = useMemo(
    () => Math.max(0, TABS.findIndex((t) => t.key === tab)),
    [tab],
  );

  return (
    <div
      className="ai-segmented"
      role="tablist"
      aria-label="Assistant mode"
      data-testid="ai-assistant-tabs"
      data-active-index={activeIndex}
    >
      <motion.span
        aria-hidden="true"
        className="ai-segmented__indicator"
        initial={false}
        animate={{ x: `${activeIndex * 100}%` }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }}
      />
      {TABS.map((t) => {
        const active = t.key === tab;
        const Icon = t.Icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-pressed={active}
            onClick={() => onChange && onChange(t.key)}
            data-testid={`ai-assistant-tab-${t.key}`}
            className={`ai-segmented__btn ${active ? "is-active" : ""}`}
          >
            <Icon className="ai-segmented__icon" aria-hidden="true" />
            <span className="ai-segmented__label">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
