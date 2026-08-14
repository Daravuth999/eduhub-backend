/**
 * interactionTierPolicy.js — Signature Smart Interactive Book, Checkpoint 1.
 *
 * Client-side MIRROR of book_factory_interaction_planner.py's
 * TIER_INTERACTION_POLICY, for display-only UI decisions (e.g. whether to
 * show a "Practise with EduTalk" affordance for a given type). This is NOT
 * authoritative — the backend planner decides what actually got generated
 * into a book; this table only helps the Reader/Editor UI describe tier
 * differences without a network round-trip. Keep in sync by hand; a
 * mismatch here never changes what content a student can actually access.
 */
export const TIER_INTERACTION_POLICY = {
  free: {
    allowedTypes: ["reveal", "mission"],
    densityBudget: 1,
    maxOptionalCount: 1,
    vocabPresentation: "compact",
  },
  standard: {
    allowedTypes: ["pronunciation", "matchpairs", "checkpoint", "mission", "reveal"],
    densityBudget: 4,
    maxOptionalCount: 2,
    vocabPresentation: "grid",
  },
  premium: {
    allowedTypes: [
      "pronunciation", "matchpairs", "sentencebuilder", "responsechoice",
      "branchdialog", "checkpoint", "mission", "reveal",
    ],
    densityBudget: 8,
    maxOptionalCount: 3,
    vocabPresentation: "grid_layered",
  },
  limited: {
    allowedTypes: [
      "pronunciation", "matchpairs", "sentencebuilder", "responsechoice",
      "branchdialog", "checkpoint", "mission", "reveal",
    ],
    densityBudget: 9,
    maxOptionalCount: 4,
    vocabPresentation: "grid_layered",
  },
};

export function tierPolicy(tier) {
  const key = (tier || "free").toLowerCase();
  return TIER_INTERACTION_POLICY[key] || TIER_INTERACTION_POLICY.free;
}
