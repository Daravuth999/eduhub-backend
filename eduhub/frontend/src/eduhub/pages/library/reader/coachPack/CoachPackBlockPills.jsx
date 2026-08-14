/**
 * CoachPackBlockPills.jsx — per-block "Save sentence" pill row.
 *
 * Renders nothing if:
 *   - the student is unauthenticated
 *   - the book tier disables Hard Sentences for this student
 *   - the block text is too short to be useful
 *
 * Long-press hint is implemented via tap (long-press is best done by the
 * existing SelectableBlock parent which already handles the selection
 * gesture; we ride on its `isSelected` gate).
 *
 * On save success a toast-like inline confirmation is shown for 2s.
 */
import { useState } from "react";
import { Bookmark, Sparkles, Loader2, Check } from "lucide-react";
import { useAuth } from "../../../../context/AuthContext";
import { saveSentence } from "../../../../lib/coachPackApi";

const MIN_CHARS = 12;

export default function CoachPackBlockPills({
  blockText, bookSlug, bookTier, chapterIdx = -1,
}) {
  const { isAuthenticated, student } = useAuth();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  if (!isAuthenticated || !student?.studentId) return null;
  if (!blockText || blockText.trim().length < MIN_CHARS) return null;

  const tier = (bookTier || "free").toLowerCase();
  // Free tier shows a teaser-only pill that links to the upgrade modal already
  // surfaced by PremiumAiAction — we just render a soft locked label.
  const locked = tier === "free";

  const onSave = async () => {
    if (locked) return;
    setBusy(true); setError(""); setSaved(false);
    const text = blockText.trim().slice(0, 1200);
    const r = await saveSentence({
      sentenceText: text,
      bookSlug,
      chapterIdx,
      whyHard: "",
    });
    setBusy(false);
    if (r?.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(r?.message || "Could not save right now.");
      setTimeout(() => setError(""), 3000);
    }
  };

  return (
    <div
      style={{ display: "inline-flex", gap: 6, marginTop: 6, marginLeft: 8 }}
      data-testid="coach-block-pills"
    >
      <button
        type="button"
        className="coach-pill"
        disabled={busy || locked}
        onClick={onSave}
        data-testid="coach-save-sentence-btn"
        aria-label={locked ? "Upgrade to save sentences" : "Save this sentence"}
        title={locked ? "Available on Standard" : "Save this sentence to your Hard Sentences"}
      >
        {busy ? <Loader2 size={11} className="animate-spin" />
          : saved ? <Check size={11} />
          : <Bookmark size={11} />}
        {locked ? "Save (Standard+)" : saved ? "Saved" : "Save sentence"}
      </button>
      {!locked && error && (
        <span className="coach-card__error" data-testid="coach-save-sentence-error">{error}</span>
      )}
    </div>
  );
}
