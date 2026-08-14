/**
 * interactionDensityPolicy.js — Signature Smart Interactive Book,
 * Checkpoint 1.
 *
 * Client-side MIRROR of book_factory_interaction_planner.py's
 * INTERACTION_WEIGHTS — display-only (e.g. an Author Studio density
 * indicator in a later checkpoint). The backend planner is authoritative
 * for what actually gets generated; nothing here gates content.
 */
export const INTERACTION_WEIGHTS = {
  reveal: 1,
  mission: 1,
  pronunciation: 2,
  matchpairs: 2,
  responsechoice: 2,
  sentencebuilder: 3,
  checkpoint: 4,
  branchdialog: 4,
};

export function densityWeight(type) {
  return INTERACTION_WEIGHTS[type] ?? 1;
}

export function totalDensity(types) {
  return (types || []).reduce((sum, t) => sum + densityWeight(t), 0);
}
