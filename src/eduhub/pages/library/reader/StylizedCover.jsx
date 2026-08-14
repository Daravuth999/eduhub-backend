/**
 * StylizedCover — deterministic, pattern-based "designed" placeholder
 * that stands in for a missing / broken book cover image.
 *
 * Guarantees a visually consistent, premium-looking cover so the
 * library grid never shows an empty gradient block. The pattern is
 * section-aware (story / conversation / exercise), picks up the book's
 * own `coverGradient` + `accent` color, and anchors the layout with a
 * large stylized monogram of the book's title.
 *
 * Purely presentational — zero props leak into global state.
 */
export default function StylizedCover({
  title = "",
  section = "story",
  gradient,
  accent,
  emoji,
  testid = "stylized-cover",
}) {
  const mono = monogramFor(title);
  const tag =
    section === "exercise"
      ? "Practice"
      : section === "conversation"
      ? "Dialogue"
      : "Story";

  return (
    <div
      className="stylized-cover"
      data-section={section || "story"}
      data-testid={testid}
      style={{
        // Exposed to the stylesheet via custom properties so the
        // gradient / accent per book stays cohesive.
        "--sc-gradient": gradient || "linear-gradient(155deg, #3A1B1B 0%, #6A2D2D 100%)",
        "--sc-accent": accent || "#D4A843",
      }}
    >
      <span className="stylized-cover__corner stylized-cover__corner--tl" aria-hidden />
      <span className="stylized-cover__corner stylized-cover__corner--br" aria-hidden />
      <div className="stylized-cover__glyph">
        <span className="stylized-cover__mono" aria-hidden>
          {emoji && emoji.length <= 3 ? emoji : mono}
        </span>
        <span className="stylized-cover__title">{title || "Untitled"}</span>
        <span className="stylized-cover__tag">{tag}</span>
      </div>
    </div>
  );
}

function monogramFor(title) {
  const clean = String(title || "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
  if (!clean) return "?";
  const words = clean.split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
