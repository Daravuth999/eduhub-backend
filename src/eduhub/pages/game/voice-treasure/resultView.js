/**
 * resultView.js — pure helpers for rendering the evaluation result. Enforces
 * that ONLY the five allowed score categories are ever displayed, in a fixed
 * order, so no invented metric (pronunciation/fluency/etc.) can leak into the UI.
 */
export const SCORE_ORDER = [
  "relevance", "visual_grounding", "detail", "organization", "understandable_language",
];

export const SCORE_LABELS = {
  relevance: "Relevance",
  visual_grounding: "Visual grounding",
  detail: "Detail",
  organization: "Organization",
  understandable_language: "Clear language",
};

/** Map a scores object to ordered, clamped rows, ignoring any unexpected key. */
export function scoreRows(scores) {
  const s = scores || {};
  return SCORE_ORDER.filter((k) => k in s).map((k) => ({
    key: k,
    value: Math.max(0, Math.min(100, Number(s[k]) || 0)),
  }));
}
