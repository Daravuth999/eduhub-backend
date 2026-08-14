// ContinueLearningShelf.jsx — "Continue Learning" shelf (Home Dashboard V4).
//
// Per the approved Phase 2 blueprint (§6 Continue Learning Strategy): a
// cross-feature "resume anything" shelf does not exist anywhere in this
// codebase today, and most of it cannot be built honestly right now —
//   • Library reading progress is the ONLY source with real, readable
//     data (two localStorage keys), but it is PER-DEVICE, not per-student
//     (nothing here is namespaced by studentId). Shipped anyway, with that
//     limitation, because hiding real progress a student already has would
//     be a worse outcome than a device-scoped resume shelf.
//   • Speaking / AI Assistant mission progress has ZERO persistence today
//     (confirmed: no localStorage, no backend "resume mission" endpoint —
//     Assistant.jsx's mission state is plain useState that resets on
//     reload). A card for it would have no real data to show, so it is
//     intentionally NOT rendered here rather than faked.
//   • Attendance streak/tier IS real and student-keyed, but it is a
//     statistic, not a resumable content item — it lives in
//     DashboardHeader instead, not this shelf.
//
// The read logic below is a deliberate, small, presentation-layer
// duplicate of Library's ContinueReading.jsx (same two localStorage keys,
// same de-dupe-by-slug-keep-latest approach) rather than an import from
// it — this reconstruction's scope is strictly limited to Dashboard-owned
// files, and Library's own component/UI must stay byte-for-byte untouched.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { BookmarkCheck, Headphones, BookOpen, MessageCircle, Brain, Library, Play, RotateCcw, CheckCircle2 } from "lucide-react";
import { easing, duration, stagger, spring, ambient } from "../../styles/tokens/motionTokens";
import { elevation } from "../../styles/tokens/designTokens";
import { useAuth } from "../../context/AuthContext";
import useAmbientActive from "../../hooks/useAmbientActive";
import EmptyStateCard from "./EmptyStateCard";

const BOOKMARK_KEY_PREFIX = "eduhub_book_bm_";
const AUDIO_PROGRESS_KEY = "eduhub_reader_audio_progress";

const SECTION_ICON = { story: BookOpen, conversation: MessageCircle, exercise: Brain };
const SECTION_LABEL = { story: "Story", conversation: "Conversation", exercise: "Exercise" };
const SECTION_ACCENT = { story: "#3B82F6", conversation: "#EC4899", exercise: "#22C55E" };

// v9.7 — Reader's bookmark schema moved to v2 (chapterIdx/subIdx) some time
// ago; this reader still checked the retired v1 shape (`pageIndex`), so the
// bookmark path had gone silently dead — every card on this shelf was
// actually arriving via the audio-progress path only. Fixed to read the
// schema Reader actually writes. `percent`, when present, is the EXACT
// completion percentage Reader itself computed at bookmark time (added
// additively to the v2 write in ReaderPage.jsx) — never recomputed or
// estimated here, since that would require Reader's live viewport/font-size
// state this component doesn't have. Older bookmarks written before that
// change simply have no `percent` and fall back to the page-number display.
function readBookmarks(catalog) {
  const out = [];
  for (const b of catalog) {
    try {
      const raw = localStorage.getItem(BOOKMARK_KEY_PREFIX + b.slug);
      if (!raw) continue;
      const v = JSON.parse(raw);
      if (v?.v === 2 && typeof v.chapterIdx === "number") {
        const percent = Number.isFinite(v.percent) ? Math.max(0, Math.min(100, v.percent)) : null;
        out.push({
          book: b,
          chapterIdx: v.chapterIdx,
          percent,
          ts: Number(v.ts) || 0,
          source: "bookmark",
        });
      }
    } catch { /* ignore corrupt entries */ }
  }
  return out;
}

// `duration`, when present, was persisted alongside elapsed time in
// AudioPlayerContext.jsx (additive) — real audio-element duration at save
// time, never guessed. Absent for entries saved before that change or
// while metadata hadn't resolved yet.
function readAudioProgress(catalog) {
  const out = [];
  try {
    const raw = localStorage.getItem(AUDIO_PROGRESS_KEY);
    if (!raw) return out;
    const map = JSON.parse(raw);
    if (!map || typeof map !== "object") return out;
    for (const [url, info] of Object.entries(map)) {
      if (!url || !info?.t) continue;
      const matched = catalog.find((b) =>
        (b.chapters || []).some((c) =>
          (c.blocks || []).some((blk) => blk.type === "audio" && blk.text && url.includes(blk.text)),
        ),
      );
      if (!matched) continue;
      const duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : null;
      const audioSeconds = Number(info.t) || 0;
      const percent = duration ? Math.max(0, Math.min(100, Math.round((audioSeconds / duration) * 100))) : null;
      out.push({ book: matched, audioSeconds, duration, percent, ts: Number(info.ts) || 0, source: "audio" });
    }
  } catch { /* ignore */ }
  return out;
}

function fmtAudio(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function ContinueLearningShelf() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth() || {};
  const [items, setItems] = useState(null); // null = still loading catalog
  // RC2.5 — gates the "active card" breathing shadow (the one continuous
  // ambient loop in this shelf); off-screen, hidden-tab, or reduced-motion
  // all pause it. The rest of this shelf's motion is one-shot (entrance,
  // progress fill, shimmer, pulse) and unaffected.
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();

  useEffect(() => {
    // Same auth gate LibraryPage.jsx applies to ContinueReading — a
    // logged-out visitor's device-local bookmarks aren't attributable to
    // any student, so nothing resumable is shown until signed in.
    if (!isAuthenticated) {
      setItems([]);
      return undefined;
    }
    let cancelled = false;
    import("../../pages/library/books/booksService")
      .then((m) => m.getAllBooks({ isAuthenticated: true }))
      .then((catalog) => {
        if (cancelled || !Array.isArray(catalog)) return;
        const all = [...readBookmarks(catalog), ...readAudioProgress(catalog)];
        const bySlug = new Map();
        for (const it of all) {
          const slug = it.book?.slug;
          if (!slug) continue;
          const cur = bySlug.get(slug);
          if (!cur || (it.ts || 0) > (cur.ts || 0)) bySlug.set(slug, it);
        }
        setItems(
          Array.from(bySlug.values())
            .sort((a, b) => (b.ts || 0) - (a.ts || 0))
            .slice(0, 8),
        );
      })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // Still resolving the catalog/localStorage read, or genuinely signed
  // out — no section at all, matching the prior (pre-empty-state)
  // behavior for guests. `items === null` only ever happens mid-load.
  if (items === null) return null;
  if (!isAuthenticated) return null;

  if (items.length === 0) {
    return (
      <section data-testid="continue-learning-shelf">
        <div className="px-4 mb-2.5">
          <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Continue Learning</h2>
        </div>
        <div className="px-4">
          <EmptyStateCard
            Icon={Library}
            accent={SECTION_ACCENT.story}
            title="Nothing in progress yet"
            subtitle="Start a story, conversation, or exercise in the Library and it'll show up here to resume."
            ctaLabel="Browse the Library"
            ctaHref="/library"
            compact
            data-testid="continue-learning-empty"
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid="continue-learning-shelf" ref={ambientRef}>
      <div className="px-4 mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Continue Learning</h2>
      </div>

      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 -mx-0 pb-1 snap-x snap-proximity">
        {items.map((it, i) => {
          // "Active card" per the RC2.5 spec — the most recently touched
          // item, i.e. the first one (list is already sorted by ts desc).
          const isActiveCard = i === 0;
          const b = it.book;
          const section = b.section || "story";
          const Icon = SECTION_ICON[section] || BookOpen;
          const accent = SECTION_ACCENT[section] || SECTION_ACCENT.story;
          // Real completion signal only — `percent` is either the exact
          // value Reader/AudioPlayerContext persisted, or null (never
          // estimated). Visual emphasis (badge, bar, CTA label) is driven
          // entirely by that real number.
          const hasPercent = it.percent != null;
          const isComplete = hasPercent && it.percent >= 100;
          const isAlmostDone = hasPercent && !isComplete && it.percent >= 90;
          const remainingSeconds =
            it.source === "audio" && it.duration != null
              ? Math.max(0, it.duration - it.audioSeconds)
              : null;

          // "Active card" breathing shadow — a very soft glowing halo that
          // pulses in and out, purely presentational (no data implied).
          const breathe = isActiveCard && ambientActive;
          const restShadow = elevation.soft;
          const peakShadow = `${elevation.soft}, 0 0 20px ${accent}30`;

          return (
            <motion.button
              key={b.slug}
              type="button"
              initial={{ opacity: 0, y: 10 }}
              animate={{
                opacity: 1,
                y: 0,
                boxShadow: breathe ? [restShadow, peakShadow, restShadow] : restShadow,
              }}
              transition={{
                duration: duration.base,
                delay: i * stagger.tight,
                ease: easing.premiumEaseOut,
                boxShadow: breathe
                  ? { duration: ambient.breathe, repeat: Infinity, ease: "easeInOut", delay: duration.base + i * stagger.tight }
                  : { duration: duration.base },
              }}
              whileTap={{ scale: 0.97 }}
              whileHover={{ y: -2 }}
              onClick={() => navigate(`/library/read/${b.slug}`)}
              className="snap-start flex-none w-[168px] text-left rounded-2xl p-3 bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08]"
              data-testid={`continue-learning-card-${i}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center"
                  style={{ background: `${accent}1A`, color: accent }}
                >
                  <Icon className="w-4.5 h-4.5" />
                </div>
                {isComplete && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide"
                    style={{ color: accent }}
                  >
                    <CheckCircle2 className="w-3 h-3" /> Done
                  </span>
                )}
                {isAlmostDone && (
                  <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: accent }}>
                    Almost there
                  </span>
                )}
              </div>

              <p className="text-[9.5px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/40">
                {SECTION_LABEL[section] || "Story"}
              </p>
              <p className="text-[0.82rem] font-bold text-ink dark:text-white leading-tight mt-0.5 line-clamp-2">
                {b.title}
              </p>

              {hasPercent ? (
                <div className="mt-2.5" data-testid={`continue-learning-progress-${i}`}>
                  <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/10 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: accent }}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(4, Math.min(100, it.percent))}%` }}
                      transition={{ ...spring.settle, delay: 0.15 + i * stagger.tight }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] font-bold" style={{ color: accent }}>
                      {Math.round(it.percent)}% {isComplete ? "complete" : ""}
                    </span>
                    {remainingSeconds != null && !isComplete && (
                      <span className="text-[9.5px] text-zinc-400 dark:text-white/40">
                        {fmtAudio(remainingSeconds)} left
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold" style={{ color: accent }}>
                  {it.source === "audio" ? (
                    <><Headphones className="w-3 h-3" /> Resume {fmtAudio(it.audioSeconds)}</>
                  ) : (
                    <><BookmarkCheck className="w-3 h-3" /> Chapter {it.chapterIdx + 1}</>
                  )}
                </p>
              )}

              <div
                className="relative mt-2.5 inline-flex items-center justify-center gap-1.5 w-full py-1.5 rounded-full text-[10.5px] font-bold overflow-hidden"
                style={
                  isComplete
                    ? { background: `${accent}14`, color: accent }
                    : { background: accent, color: "#fff" }
                }
              >
                {/* One-shot shimmer sweep, once per mount — "the Resume
                    button receives one elegant shimmer." */}
                {!isComplete && (
                  <motion.span
                    aria-hidden
                    className="absolute inset-0"
                    style={{ background: "linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.5) 48%, transparent 66%)" }}
                    initial={{ x: "-120%" }}
                    animate={{ x: "120%" }}
                    transition={{ duration: 0.9, delay: duration.base + i * stagger.tight + 0.3, ease: easing.premiumEaseOut }}
                  />
                )}
                {isComplete ? (
                  <><RotateCcw className="w-3 h-3" /> Read again</>
                ) : (
                  <>
                    <motion.span
                      className="inline-flex"
                      initial={{ scale: 1 }}
                      animate={{ scale: [1, 1.18, 1] }}
                      transition={{ duration: 0.5, delay: duration.base + i * stagger.tight + 0.3, ease: easing.premiumEaseOut }}
                    >
                      <Play className="w-3 h-3" />
                    </motion.span>
                    Resume
                  </>
                )}
              </div>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}
