// CoachHero.jsx — thin adapter over <StatusPills />.
//
// v5: no longer takes a `tab` prop — StatusPills doesn't need it (the
// live/paused segment it used to compute from `tab` was dropped as a
// duplicate of PausedStateCard). Whether this renders at all is now
// decided by the parent (Assistant.jsx wraps it in AnimatePresence and
// stops mounting it once a real conversation is under way). data-testid
// contract preserved: ai-assistant-personal-hero, -avatar, -greeting,
// -points, -cost.
//
// No business logic changed. All live data still flows from
// AuthContext + getAssistantConfig().

import React from "react";
import StatusPills from "./StatusPills";

export default function CoachHero() {
  return <StatusPills />;
}
