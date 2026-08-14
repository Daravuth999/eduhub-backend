/**
 * AchievementDecorations.jsx — thin wrapper over the shared DecorationLayer
 * (generalized this pass for the Promotion Experience Studio directive, see
 * decorations/DecorationLayer.jsx). Kept as its own file/export so every
 * existing import (TopEarnerPanel.jsx) and the exact data-testid contract
 * (`achievement-decoration-{type}`, `achievement-decorations`) this
 * module's own tests assert on stay byte-for-byte unchanged — this is a
 * generalization, not a behavior change.
 */
import DecorationLayer from "./decorations/DecorationLayer";

export default function AchievementDecorations({ decorations, animateEnabled }) {
  return <DecorationLayer decorations={decorations} animateEnabled={animateEnabled} testidPrefix="achievement" />;
}
