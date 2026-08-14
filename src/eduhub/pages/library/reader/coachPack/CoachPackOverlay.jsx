/**
 * CoachPackOverlay.jsx — additive reader overlay.
 *
 * Mounts (all client-side gated by tier + props):
 *   • <ProgressChip />              top-right, pinned
 *   • <CoachBriefingCard />         bottom card, dismissible
 *   • <CompletionCelebrationCard /> mid-screen modal on chapter completion
 *
 * Hard isolation:
 *   - Does NOT touch ReaderPage state, AudioPlayerContext, or EduTalk.
 *   - Wrapped in its own ErrorBoundary so a render failure cannot
 *     blank the reader.
 *   - Returns null when student is unauthenticated.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Sparkles, X, Flame, BookOpen, ChevronRight, Compass } from "lucide-react";
import { useAuth } from "../../../../context/AuthContext";
import useCoachPack from "./useCoachPack";
import { completeChapter } from "../../../../lib/coachPackApi";
import CoachPackTab from "./CoachPackTab";
import "./coachPack.css";

class _ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(err) { try { console.warn("[CoachPack] overlay caught:", err); } catch {} }
  render() { return this.state.broken ? null : this.props.children; }
}

export default function CoachPackOverlay({
  bookSlug, bookTitle, bookTier, chapterIdx, chapterTitle, visibleText,
  totalChapters, chapterCompleted,
}) {
  const { isAuthenticated, student } = useAuth();
  const [briefingDismissed, setBriefingDismissed] = useState(false);
  const [completionShown, setCompletionShown] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const cp = useCoachPack({ bookSlug, chapterIdx, student });

  // Pull the cached password from AuthContext (same pattern as EduTalkPanel).
  const studentPassword = useMemo(() => {
    if (!student) return "";
    try {
      if (student.password) return String(student.password);
      const pd = student.passwordData || {};
      return String(pd.Password ?? pd.password ?? "");
    } catch {
      return "";
    }
  }, [student]);

  // When chapterCompleted flips true we fire complete-chapter once.
  useEffect(() => {
    if (!isAuthenticated || !bookSlug || chapterIdx < 0) return;
    if (chapterCompleted !== true) return;
    let cancelled = false;
    (async () => {
      const res = await completeChapter({
        bookSlug, chapterIdx, totalChapters: totalChapters || 0,
      });
      if (!cancelled && res?.success && res.first_time) {
        setCompletionShown(res);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, bookSlug, chapterIdx, totalChapters, chapterCompleted]);

  if (!isAuthenticated || !student?.studentId) return null;
  if (!bookSlug) return null;

  const streak = cp?.slp?.streak_days || 0;
  const completedCount = cp?.progress?.completed_count || 0;
  const tier = (bookTier || "free").toLowerCase();
  const briefingVisible = !briefingDismissed && !!cp.briefing && !cp.loading;

  return (
    <_ErrorBoundary>
      <div className="coach-overlay" data-testid="coach-overlay">
        {/* Progress chip */}
        <div
          className="coach-progress-chip"
          data-tier={tier}
          data-testid="coach-progress-chip"
          aria-label={`Progress: ${completedCount} of ${totalChapters || "?"} chapters complete. Streak ${streak} days.`}
        >
          <BookOpen size={13} aria-hidden="true" />
          <span data-testid="coach-progress-pct">
            {completedCount}{totalChapters ? `/${totalChapters}` : ""}
          </span>
          {streak >= 2 && (
            <span className="coach-progress-chip__streak" data-testid="coach-streak">
              <Flame size={12} aria-hidden="true" /> {streak}d
            </span>
          )}
        </div>

        {/* Briefing card */}
        {briefingVisible && (
          <div
            className="coach-briefing"
            data-testid="coach-briefing-card"
            data-state="visible"
          >
            <p className="coach-briefing__title">
              <Sparkles size={12} aria-hidden="true" style={{ marginRight: 6 }} />
              Coach Briefing
            </p>
            <p className="coach-briefing__body" data-testid="coach-briefing-text">
              {cp.briefing}
            </p>
            <button
              type="button"
              className="coach-briefing__dismiss"
              aria-label="Dismiss briefing"
              data-testid="coach-briefing-dismiss"
              onClick={() => setBriefingDismissed(true)}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Completion celebration */}
        {completionShown && (
          <div className="coach-completion" data-testid="coach-completion" role="dialog" aria-live="polite">
            <div className="coach-completion__card" data-tier={tier}>
              <Sparkles size={28} color="var(--coach-accent)" aria-hidden="true" />
              <p className="coach-completion__title" data-testid="coach-completion-title">
                Chapter complete!
              </p>
              <p style={{ color: "var(--coach-text-muted)", fontSize: 13, margin: "4px 0 0" }}>
                {completionShown.progress_pct}% through the book
              </p>
              <div className="coach-completion__stats">
                <div className="coach-completion__stat">
                  <span className="coach-completion__stat-num">{completionShown.words_saved_this_chapter || 0}</span>
                  <span className="coach-completion__stat-label">Words</span>
                </div>
                <div className="coach-completion__stat">
                  <span className="coach-completion__stat-num">{completionShown.sentences_saved_this_chapter || 0}</span>
                  <span className="coach-completion__stat-label">Sentences</span>
                </div>
                <div className="coach-completion__stat">
                  <span className="coach-completion__stat-num">{completionShown.streak_days || streak || 0}d</span>
                  <span className="coach-completion__stat-label">Streak</span>
                </div>
              </div>
              {completionShown.badge && (
                <p style={{ color: "var(--coach-accent)", fontWeight: 700, marginTop: 10 }}
                   data-testid="coach-badge-earned">
                  ★ Badge earned: {completionShown.badge.label}
                </p>
              )}
              <button
                type="button"
                className="coach-card__cta"
                style={{ marginTop: 12 }}
                onClick={() => setCompletionShown(null)}
                data-testid="coach-completion-continue"
              >
                Continue <ChevronRight size={14} style={{ marginLeft: 4 }} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Coach Pack Tools launcher button — floating, top-right under chip */}
        <button
          type="button"
          onClick={() => setToolsOpen(true)}
          className="coach-progress-chip"
          data-tier={tier}
          data-testid="coach-tools-launch"
          aria-label="Open Coach Tools"
          style={{
            top: `calc(max(8px, env(safe-area-inset-top)) + 42px)`,
            background: "var(--coach-accent-soft)",
            color: "var(--coach-accent)",
            cursor: "pointer",
          }}
        >
          <Compass size={13} aria-hidden="true" />
          <span>Coach</span>
        </button>

        {/* Coach Pack Tools drawer — bottom-sheet (mobile-first) */}
        {toolsOpen && (
          <div
            data-testid="coach-tools-drawer"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 80,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setToolsOpen(false); }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 480,
                maxHeight: "82vh",
                overflowY: "auto",
                background: "var(--coach-bg)",
                borderRadius: "22px 22px 0 0",
                padding: "12px 12px 24px 12px",
                borderTop: "1px solid var(--coach-border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "4px 4px 8px 4px" }}>
                <p style={{ margin: 0, color: "var(--coach-accent)", fontWeight: 800, letterSpacing: "0.08em",
                            textTransform: "uppercase", fontSize: 12 }}>
                  <Compass size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Coach Tools
                </p>
                <button
                  type="button"
                  onClick={() => setToolsOpen(false)}
                  className="coach-briefing__dismiss"
                  style={{ position: "static" }}
                  aria-label="Close Coach Tools"
                  data-testid="coach-tools-close"
                >
                  <X size={18} />
                </button>
              </div>
              <CoachPackTab
                bookSlug={bookSlug}
                bookTitle={bookTitle}
                bookTier={bookTier}
                chapterIdx={chapterIdx}
                chapterTitle={chapterTitle}
                visibleText={visibleText}
                password={studentPassword}
              />
            </div>
          </div>
        )}
      </div>
    </_ErrorBoundary>
  );
}
