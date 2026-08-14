// PausedStateCard.jsx — v2 compact "teacher paused" state.
//
// v1 rendered a huge (~200px tall) hero-style warning block. v2 keeps
// the teacher-controlled messaging clear but folds it into a compact
// pill-shaped inline card that sits gently above the composer instead
// of pushing chat content off-screen.
//
// data-testid preserved verbatim:
//   ai-coach-disabled                (variant "ai")
//   speech-coach-missions-disabled   (variant "missions")
//   speech-go-to-free-chat-btn       (missions "go to chat" CTA)

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, MessageSquare } from "lucide-react";
import { PausedShieldSvg, SpeechMissionsBadgeSvg } from "./illustrations";
import { EASE, DURATION } from "../motion";

const VARIANTS = {
  ai: {
    Emblem: PausedShieldSvg,
    title: "AI Assistant is paused",
    body:
      "Your teacher has temporarily paused AI practice. Please check again soon.",
    testId: "ai-coach-disabled",
  },
  missions: {
    Emblem: SpeechMissionsBadgeSvg,
    title: "Speech Missions are locked",
    body:
      "Your teacher will unlock guided missions soon. Meanwhile, keep practising in Free Chat.",
    testId: "speech-coach-missions-disabled",
  },
};

export default function PausedStateCard({
  variant = "ai",
  onSwitchToChat,
  testId,
}) {
  const reduced = useReducedMotion();
  const cfg = VARIANTS[variant] || VARIANTS.ai;
  const Emblem = cfg.Emblem;

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : DURATION, ease: EASE }}
      className="ai-paused-compact"
      data-testid={testId || cfg.testId}
      role="status"
      aria-live="polite"
    >
      <span className="ai-paused-compact__art" aria-hidden="true">
        <Emblem size={40} />
      </span>
      <div className="ai-paused-compact__body">
        <div className="ai-paused-compact__title">{cfg.title}</div>
        <div className="ai-paused-compact__sub">{cfg.body}</div>
      </div>
      {variant === "missions" && typeof onSwitchToChat === "function" ? (
        <button
          type="button"
          onClick={onSwitchToChat}
          data-testid="speech-go-to-free-chat-btn"
          className="ai-paused-compact__go"
        >
          <MessageSquare style={{ width: 12, height: 12 }} aria-hidden="true" />
          Free Chat
          <ArrowRight style={{ width: 12, height: 12 }} aria-hidden="true" />
        </button>
      ) : null}
    </motion.div>
  );
}
