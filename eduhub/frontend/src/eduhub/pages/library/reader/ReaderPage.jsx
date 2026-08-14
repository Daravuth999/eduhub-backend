import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Sun,
  Moon,
  Palette,
  Minus,
  Plus,
  Bookmark,
  BookmarkCheck,
  Home,
  Check,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getBookBySlug } from "../books/booksService";
import { isUnlocked } from "../books/purchaseService";
import { useAuth } from "../../../context/AuthContext";
import { completeLessonRequest } from "../api";
import BookCover from "./BookCover";
import ChapterBlocks from "./ChapterBlocks";
import EduTalkLauncher from "./EduTalkPanel";
// EduTalk Live Coach (real-time speaking practice) — NEW, isolated launcher,
// SEPARATE from the purple EduTalk assistant and the book-narration player.
// Self-hides when the feature is disabled / Gemini is not configured.
import EduTalkLiveCoach from "./live/EduTalkLiveCoach";
// Issue 1 fix — same active-session registry EduTalkLiveCoach registers
// itself into while "live" (see lib/activeSessionRegistry.js). Used ONLY
// to pin its remount key across a page turn; never read/written by
// billing, auth, or session-recovery logic.
import { hasActiveSession } from "../../../lib/activeSessionRegistry";
import TocDrawer from "./TocDrawer";
import WelcomeOverlay from "./WelcomeOverlay";
// Coach Pack v3 — additive overlay (Progress chip + Briefing card + Completion card).
// Fully isolated; failure-safe via internal ErrorBoundary. Hidden when student
// is unauthenticated.
import CoachPackOverlay from "./coachPack/CoachPackOverlay";
import {
  BookAudioProvider,
  useBookAudio,
} from "./AudioPlayerContext";
// Reading Hub (P1) — the single floating object inside the Reader. Replaces
// the standalone PersistentMiniPlayer + EduTalk fab + Live Coach fab with
// one AssistiveTouch-style docked control that composes all three; see
// ReadingHub.jsx's own header comment for the full architecture.
import ReadingHub from "./ReadingHub";
import "./reader.css";
import "./reader-3d-modes.css";
import "./reader-cinematic.css"; /* v10 — cinematic dark-mode overlay */
import "../library-theme.css";
import "../library-cinematic.css";

const THEMES = ["light", "sepia", "dark"];
const SIZES = ["sm", "md", "lg", "xl"];
const MODES = ["premium", "minimal"];

/* ───────────────────── v9 · True-book pagination ─────────────────────
 * Chapters are now sliced into sub-pages that fit one screen, so turning
 * a page actually turns a page — not a chapter. A safety rule keeps
 * audio/video/embed/transcript/mcq/fillblank chapters UNSPLIT so the
 * existing AudioPlayerContext and ExerciseBlock state never drop frames.
 * Premium books (book.price > 0) unlock a two-page spread on ≥1024px,
 * chapter-header illustrations, accent drop-caps and an optional
 * paper-turn sound. Free books still get the new pagination, accurate
 * progress, sub-page bookmarks and a basic drop-cap.
 * ─────────────────────────────────────────────────────────────────── */
const SIZE_TO_PX = { sm: 15, md: 17, lg: 19, xl: 21 };
// v9.1 — audio/video/embed/transcript are no longer treated as
// "non-splittable" so a chapter that contains them paginates like any
// other chapter (fixing the "page becomes a tall scroll" bug).
//   • Audio playback survives page-flips because the AudioPlayerContext
//     owns a single hidden <audio> element at the reader root.
//   • Transcript blocks have `start`/`end` timestamps; the
//     transcriptPageMap below uses them to auto-flip pages as the audio
//     progresses (real opening-book behaviour).
//   • mcq / fillblank still cluster as one sub-page so an in-progress
//     exercise never gets cut in half.
const NON_SPLITTABLE_TYPES = new Set([
  "mcq",
  "fillblank",
]);
const SPREAD_MIN_WIDTH = 1024;
const TURN_SOUND_KEY = "eduhub_reader_turnsound_v1";

function bookmarkKey(slug) {
  return `eduhub_book_bm_${slug}`;
}

/**
 * Heuristic height estimator. Deliberately offscreen-free to avoid
 * layout thrash; tuned against the real .book-page padding/line-height.
 */
function estimateBlockHeight(block, fontSizePx, innerWidthPx) {
  const type = String(block?.type || "paragraph").toLowerCase();
  const text = String(block?.text || "");
  const chars = Math.max(1, text.length);
  if (type === "image") return 280;
  if (type === "heading") return fontSizePx * 2.4 + 14;
  // ~0.52 px per character at body font size, with a sane floor
  const charsPerLine = Math.max(28, Math.floor(innerWidthPx / (fontSizePx * 0.52)));
  const lines = Math.ceil(chars / charsPerLine);
  const lineH = fontSizePx * 1.72;
  const baseH = lines * lineH;
  if (type === "quote") return baseH + 56;
  if (type === "dialog") return baseH + 36;
  if (type === "markdown") return baseH * 1.2 + 24;
  if (type === "example") return baseH + 24;
  return baseH + 16; // paragraph
}

/**
 * Build the flat pagination plan. A chapter that contains any
 * NON_SPLITTABLE block is emitted as a single sub-page to protect
 * audio continuity, transcript alignment and exercise state.
 */
function paginateChapters(chapters, size, viewportH, viewportW) {
  const fontSizePx = SIZE_TO_PX[size] || 17;
  // Match .book-page width minus padding (~114px horizontal)
  const pageOuterW = Math.min(720, Math.max(320, viewportW * 0.94));
  const innerWidthPx = Math.max(260, pageOuterW - 114);
  // Match .book-page min-height: min(78vh, 820px); content area ≈ 82% of that
  const pageTargetH = Math.min(820, viewportH * 0.78) * 0.82;

  const plan = [];
  (chapters || []).forEach((ch, chapterIdx) => {
    const blocks = Array.isArray(ch?.blocks) ? ch.blocks : [];
    const hasProtected = blocks.some((b) =>
      NON_SPLITTABLE_TYPES.has(String(b?.type || "").toLowerCase())
    );

    if (hasProtected || blocks.length === 0) {
      plan.push({
        type: "content",
        chapterIdx,
        subIdx: 0,
        blocks,
        chapterTitle: ch?.title || "",
        isFirstOfChapter: true,
        isLastOfChapter: true,
        subPagesInChapter: 1,
      });
      return;
    }

    const subs = [];
    let cur = [];
    let curH = 0;
    for (const blk of blocks) {
      const h = estimateBlockHeight(blk, fontSizePx, innerWidthPx);
      if (curH + h > pageTargetH && cur.length > 0) {
        subs.push(cur);
        cur = [];
        curH = 0;
      }
      cur.push(blk);
      curH += h;
    }
    if (cur.length > 0) subs.push(cur);

    subs.forEach((subBlocks, subIdx) => {
      plan.push({
        type: "content",
        chapterIdx,
        subIdx,
        blocks: subBlocks,
        chapterTitle: ch?.title || "",
        isFirstOfChapter: subIdx === 0,
        isLastOfChapter: subIdx === subs.length - 1,
        subPagesInChapter: subs.length,
      });
    });
  });
  return plan;
}

/**
 * Tiny Web-Audio "paper click" so premium books can add tactile feedback
 * without shipping an audio asset. No-op if AudioContext is blocked.
 */
function playTurnSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = "triangle";
    o.frequency.setValueAtTime(360, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.09);
    g.gain.setValueAtTime(0.05, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
    o.start();
    o.stop(ctx.currentTime + 0.11);
    setTimeout(() => ctx.close().catch(() => {}), 250);
  } catch {
    /* ignore */
  }
}

export default function ReaderPage() {
  // Reading Hub (P1 Phase B audit fix) — lifted OUT of ReaderPageInner and
  // up to this always-mounted wrapper, matching exactly where
  // PersistentMiniPlayer used to live. ReaderPageInner has several early
  // returns (loading / error / guestLocked / contentUnavailable) that sit
  // BEFORE where EduTalkLauncher/EduTalkLiveCoach render — Hub was
  // originally nested inside that same tree, so it disappeared (taking
  // all audio transport controls with it) in any of those states, even
  // if narration was already playing. Hub now mounts here, unconditionally,
  // for the life of the BookAudioProvider — exactly the guarantee the old
  // mini player had. eduTalkFab/liveCoachFab are threaded down as props so
  // ReaderPageInner's EduTalkLauncher/EduTalkLiveCoach can still report
  // into them.
  const [eduTalkFab, setEduTalkFab] = useState(null);
  const [liveCoachFab, setLiveCoachFab] = useState(null);
  // P1 Phase C audit fix — the "You finished the book" celebration
  // (`finished` state, owned entirely by ReaderPageInner below) renders at
  // z-40, BELOW Hub's z-70, and Hub previously had no idea it existed. On a
  // narrow viewport the celebration card is real content Hub could float
  // on top of — exactly the "does Reading Hub improve this state? If not,
  // collapse/hide" case the audit calls out. Mirrored up the same additive,
  // read-only way eduTalkFab/liveCoachFab already are: zero change to the
  // completion detection, timing, or points logic itself.
  const [celebrating, setCelebrating] = useState(false);
  return (
    <BookAudioProvider>
      <ReaderPageInner
        onEduTalkFabState={setEduTalkFab}
        onLiveCoachFabState={setLiveCoachFab}
        onFinishedChange={setCelebrating}
      />
      <ReadingHub eduTalk={eduTalkFab} liveCoach={liveCoachFab} celebrating={celebrating} />
    </BookAudioProvider>
  );
}

function ReaderPageInner({ onEduTalkFabState, onLiveCoachFabState, onFinishedChange }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, student, isBootstrapping } = useAuth();

  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Audit addition (P0 hardening) — lets the contentUnavailable retry card
  // re-run the book-load effect in place, without remounting the page (a
  // remount would flash the whole shell — exactly the class of bug the
  // bootstrap-window hotfix this session eliminated elsewhere).
  const [retryNonce, setRetryNonce] = useState(0);

  const [pageIndex, setPageIndex] = useState(0); // 0 = cover
  const [direction, setDirection] = useState(1);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("eduhub_reader_theme") || "sepia"
  );
  const [size, setSize] = useState(
    () => localStorage.getItem("eduhub_reader_size") || "md"
  );
  const [mode, setMode] = useState(
    () => localStorage.getItem("eduhub_reader_mode") || "premium"
  );
  const [tocOpen, setTocOpen] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [finished, setFinished] = useState(false);
  // P1 Phase C audit fix — read-only mirror of `finished` up to Reading Hub
  // (see ReaderPage's own comment above). Does not affect `finished` itself.
  useEffect(() => {
    onFinishedChange?.(finished);
  }, [finished, onFinishedChange]);
  const [pointsEarned, setPointsEarned] = useState(null);
  const [turnSoundOn, setTurnSoundOn] = useState(
    () => (typeof localStorage !== "undefined" && localStorage.getItem(TURN_SOUND_KEY) === "on") || false
  );
  const completionFiredRef = useRef(false);
  const bookmarkAppliedRef = useRef(false);
  // Issue 1 fix — holds the last chapter-scoped EduTalk Live Coach remount
  // key while a live session is active (see usage below, after
  // `currentPage` is computed). Declared here (unconditional top-level
  // hook) so the later plain-JS read/write after early returns stays
  // rules-of-hooks safe.
  const liveCoachKeyRef = useRef(null);

  // Viewport tracking so pagination reflows on resize / orientation change
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1024,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  }));
  useEffect(() => {
    let t;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(
        () => setViewport({ w: window.innerWidth, h: window.innerHeight }),
        120
      );
    };
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-reader-active", "true");
    document.body.setAttribute("data-library-theme", "true");
    return () => {
      document.body.removeAttribute("data-reader-active");
      document.body.removeAttribute("data-library-theme");
      document.body.removeAttribute("data-reader-section");
    };
  }, []);

  useEffect(() => {
    if (book?.section) document.body.setAttribute("data-reader-section", book.section);
    else document.body.removeAttribute("data-reader-section");
  }, [book?.section]);

  // v9.6 — Laptop book-opening loop fix.
  //
  // Previously this effect depended on `student?.portalData` (an OBJECT
  // reference).  AuthContext recreates that object whenever it merges
  // new fields (15s restriction watchdog tick, GAS hydration, cross-tab
  // storage sync, etc.).  Every new reference re-fired the effect,
  // which re-fetched the book and re-evaluated `isUnlocked()`.  On a
  // laptop where GAS hydration / unlocks-cache hydration / restriction
  // poll all race, the very first evaluation could read a stale
  // `portalData.UnlockedBooks` and call `navigate("/library")` even
  // for a book the student actually owns — bouncing the user back to
  // the library, where they would click the book again and re-enter
  // the same race.  The visible symptom is a flicker loop between the
  // reader and the library on cold-laptop loads.
  //
  // Two-part fix:
  //   1. Wait for `isBootstrapping === false` so the unlocks check
  //      sees fully hydrated state at least once.
  //   2. Depend on the stable `UnlockedBooks` STRING (the only field
  //      `isUnlocked()` actually reads off `portalData`), not the
  //      whole `portalData` object — so post-hydration setStudent()
  //      calls that don't change unlocks no longer re-fire this effect.
  const portalUnlocksKey = (
    student?.portalData?.UnlockedBooks
    ?? student?.portalData?.unlockedBooks
    ?? student?.portalData?.Inventory
    ?? student?.portalData?.inventory
    ?? ""
  ).toString();
  useEffect(() => {
    if (isBootstrapping) return;
    let alive = true;
    setLoading(true);
    setError(null);
    getBookBySlug(slug, { isAuthenticated })
      .then((b) => {
        if (!alive) return;
        if (!b) {
          setError("We couldn't find that book. It may have been moved.");
          setBook(null);
          return;
        }
        // Guest reading experience — a guest has no wallet and no
        // purchases, so this existing purchase-entitlement check (which
        // exists to bounce an authenticated student back to /library if
        // they navigate straight to a priced book's URL without having
        // unlocked it) doesn't apply to them at all. For a guest, the
        // backend's own guest content boundary has already decided what's
        // visible — a priced book simply arrives with no `chapters`/
        // `content`, handled below by the guestLocked render branch,
        // instead of a silent bounce back to the Library with no
        // explanation.
        const price = Number(b.price) || 0;
        if (isAuthenticated && price > 0 && !isUnlocked(student?.studentId, b, student?.portalData)) {
          navigate("/library", { replace: true });
          return;
        }
        setBook(b);
      })
      .catch((e) => {
        console.error(e);
        if (alive) setError("There was a problem loading this book.");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, student?.studentId, navigate, portalUnlocksKey, isBootstrapping, isAuthenticated, retryNonce]);

  useEffect(() => {
    localStorage.setItem("eduhub_reader_theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("eduhub_reader_size", size);
  }, [size]);
  useEffect(() => {
    localStorage.setItem("eduhub_reader_mode", mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem(TURN_SOUND_KEY, turnSoundOn ? "on" : "off");
  }, [turnSoundOn]);

  // Tier signals
  // v9.4 — Visual treatment is now driven exclusively by the Author-
  // selected tier badge. `isPremium` decides decorative-only features
  // (drop-caps, chapter ticks, paper grain, two-page spread, turn-sound).
  // The previous `price > 0` coupling has been removed so a 0-pt promo
  // book authored as "premium" gets the decorative treatment and a
  // 200-pt book authored as "standard" stays understated.
  //
  // Pricing / entitlement is read elsewhere from `book.price` +
  // `isUnlocked(...)` and is intentionally NOT affected here.
  const tier = String(book?.tier || "").toLowerCase();
  const isPremium = useMemo(
    () => tier === "premium" || tier === "limited",
    [tier]
  );
  const isLimited = tier === "limited";
  const canSpread = isPremium && viewport.w >= SPREAD_MIN_WIDTH;

  // v9.1 — Audio engine for transcript-driven auto-flip.
  const audio = useBookAudio();

  // Build sub-page plan
  const subPagePlan = useMemo(() => {
    if (!book?.chapters) return [];
    return paginateChapters(book.chapters, size, viewport.h, viewport.w);
  }, [book?.chapters, size, viewport.h, viewport.w]);

  // Flat pages = cover + sub-pages
  const pages = useMemo(() => {
    if (!book) return [];
    return [{ type: "cover" }, ...subPagePlan];
  }, [book, subPagePlan]);

  const totalContent = Math.max(1, pages.length - 1);
  const progress = useMemo(() => {
    if (pageIndex <= 0) return 0;
    return Math.min(100, Math.round((pageIndex / totalContent) * 100));
  }, [pageIndex, totalContent]);

  // Clamp pageIndex whenever the pagination plan shrinks (size change, resize)
  useEffect(() => {
    if (pageIndex > pages.length - 1) {
      setPageIndex(Math.max(0, pages.length - 1));
    }
  }, [pages.length, pageIndex]);

  // Chapter-level TOC (preserves the existing drawer contract)
  const tocPages = useMemo(() => {
    if (!book) return [];
    return [
      { type: "cover" },
      ...(book.chapters || []).map((c) => ({ type: "chapter", title: c.title })),
    ];
  }, [book]);

  const tocActiveIndex = useMemo(() => {
    if (pageIndex === 0) return 0;
    const p = pages[pageIndex];
    return p && p.type === "content" ? (p.chapterIdx ?? 0) + 1 : 0;
  }, [pageIndex, pages]);

  // Bookmark (v2 schema) — backward-compatible with the old single-pageIndex value
  useEffect(() => {
    if (!book || bookmarkAppliedRef.current || pages.length <= 1) return;
    try {
      const raw = localStorage.getItem(bookmarkKey(book.slug));
      if (!raw) return;
      const v = JSON.parse(raw);
      if (v && v.v === 2 && typeof v.chapterIdx === "number") {
        const targetSub = typeof v.subIdx === "number" ? v.subIdx : 0;
        const exact = pages.findIndex(
          (p) =>
            p.type === "content" &&
            p.chapterIdx === v.chapterIdx &&
            p.subIdx === targetSub
        );
        const firstOfChapter = pages.findIndex(
          (p) => p.type === "content" && p.chapterIdx === v.chapterIdx && p.subIdx === 0
        );
        const idx = exact > 0 ? exact : firstOfChapter;
        if (idx > 0) {
          setPageIndex(idx);
          setBookmarked(true);
        }
      } else if (v && typeof v.pageIndex === "number" && v.pageIndex > 0) {
        // Legacy v1 bookmark — old pageIndex == chapterIdx + 1
        const chapterIdx = v.pageIndex - 1;
        const idx = pages.findIndex(
          (p) => p.type === "content" && p.chapterIdx === chapterIdx && p.subIdx === 0
        );
        if (idx > 0) {
          setPageIndex(idx);
          setBookmarked(true);
        }
      }
    } catch {
      /* ignore */
    } finally {
      bookmarkAppliedRef.current = true;
    }
  }, [book, pages]);

  const cycleTheme = () => {
    const i = THEMES.indexOf(theme);
    setTheme(THEMES[(i + 1) % THEMES.length]);
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Palette;

  // Two-page spread only pairs adjacent sub-pages from the same chapter
  const shouldSpreadAt = useCallback(
    (idx) => {
      if (!canSpread) return false;
      const cur = pages[idx];
      const nxt = pages[idx + 1];
      if (!cur || cur.type !== "content") return false;
      if (!nxt || nxt.type !== "content") return false;
      return cur.chapterIdx === nxt.chapterIdx;
    },
    [canSpread, pages]
  );

  const go = useCallback(
    (delta) => {
      // v9.1 — stamp manual nav so transcript auto-flip yields for ~3s.
      userOverrideUntilRef.current = Date.now() + 3000;
      lastAutoFlippedToRef.current = -1;
      setDirection(delta > 0 ? 1 : -1);
      setPageIndex((i) => {
        const step = shouldSpreadAt(i) ? 2 : 1;
        const next = Math.max(
          0,
          Math.min(pages.length - 1, i + delta * step)
        );
        return next;
      });
      if (delta !== 0 && turnSoundOn && isPremium) playTurnSound();
    },
    [pages.length, shouldSpreadAt, turnSoundOn, isPremium]
  );

  const jumpTo = useCallback(
    (tocIdx) => {
      // v9.1 — stamp manual nav so transcript auto-flip yields for ~3s.
      userOverrideUntilRef.current = Date.now() + 3000;
      lastAutoFlippedToRef.current = -1;
      if (tocIdx === 0) {
        setDirection(-1);
        setPageIndex(0);
      } else {
        const chapterIdx = tocIdx - 1;
        const idx = pages.findIndex(
          (p) => p.type === "content" && p.chapterIdx === chapterIdx && p.subIdx === 0
        );
        if (idx > 0) {
          setDirection(idx > pageIndex ? 1 : -1);
          setPageIndex(idx);
        }
      }
      setTocOpen(false);
    },
    [pages, pageIndex]
  );

  useEffect(() => {
    const h = (e) => {
      if (e.target?.matches?.("input, textarea")) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
      if (e.key === "Escape") setTocOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);

  const touchStart = useRef(null);
  const onTouchStart = (e) => {
    touchStart.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e) => {
    const start = touchStart.current;
    if (start == null) return;
    const end = e.changedTouches[0].clientX;
    const dx = end - start;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
    touchStart.current = null;
  };

  // Scroll each new page to top (long media-heavy pages still scroll)
  const pageRef = useRef(null);
  const pageRefRight = useRef(null);
  useEffect(() => {
    if (pageRef.current) pageRef.current.scrollTo({ top: 0, behavior: "instant" });
    if (pageRefRight.current)
      pageRefRight.current.scrollTo({ top: 0, behavior: "instant" });
  }, [pageIndex]);

  useEffect(() => {
    if (!book || pages.length <= 1) return;
    if (pageIndex < pages.length - 1) return;
    if (completionFiredRef.current) return;
    completionFiredRef.current = true;
    setFinished(true);
    if (isAuthenticated && student?.studentId) {
      completeLessonRequest(student.studentId, book.title, book.section)
        .then((data) => {
          if (data?.success) setPointsEarned(Number(data.points) || 0);
        })
        .catch((err) => console.warn("completeLesson failed", err));
    }
  }, [pageIndex, pages.length, book, isAuthenticated, student?.studentId]);

  const toggleBookmark = () => {
    if (!book) return;
    if (bookmarked) {
      localStorage.removeItem(bookmarkKey(book.slug));
      setBookmarked(false);
    } else {
      const cur = pages[pageIndex];
      // v9.7 — Dashboard's Continue Learning shelf needs a real completion
      // percent, not an estimate. `progress` above is the exact value this
      // page already computes for its own progress bar, so we simply persist
      // the same number rather than recomputing pagination elsewhere (which
      // would require this page's live viewport/font-size state).
      const entry =
        cur?.type === "content"
          ? {
              v: 2,
              chapterIdx: cur.chapterIdx,
              subIdx: cur.subIdx,
              percent: progress,
              ts: Date.now(),
            }
          : { v: 2, chapterIdx: -1, subIdx: 0, percent: progress, ts: Date.now() };
      localStorage.setItem(bookmarkKey(book.slug), JSON.stringify(entry));
      setBookmarked(true);
    }
  };

  const sizeDelta = (d) => {
    const i = SIZES.indexOf(size);
    const ni = Math.max(0, Math.min(SIZES.length - 1, i + d));
    setSize(SIZES[ni]);
  };

  // Chapter tick positions on the progress bar (premium visual cue)
  const chapterTicks = useMemo(() => {
    if (!isPremium || pages.length <= 2) return [];
    const ticks = [];
    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      if (p.type === "content" && p.isFirstOfChapter && p.chapterIdx > 0) {
        ticks.push(Math.round((i / totalContent) * 100));
      }
    }
    return ticks;
  }, [isPremium, pages, totalContent]);

  /* ─────────────── v9.1 — Transcript-driven page auto-flip ───────────────
   * Build a map of pages that contain transcript blocks with valid
   * start/end timestamps. While the audio is playing, when its
   * currentTime crosses into a different page's transcript range, we
   * auto-flip to that page so the reader follows the audio just like
   * a real read-along book.
   *
   * Manual navigation still wins: if the student turns the page
   * themselves, we stamp `userOverrideUntilRef` for ~3 s so the auto-
   * flipper does not yank them back. After that window, the auto-flip
   * resumes following the audio cursor.
   * ──────────────────────────────────────────────────────────────────── */
  const transcriptPageMap = useMemo(() => {
    const m = [];
    pages.forEach((p, i) => {
      if (p.type !== "content") return;
      const blocks = p.blocks || [];
      let minStart = Infinity;
      let maxEnd = -Infinity;
      for (const b of blocks) {
        if (String(b?.type || "").toLowerCase() !== "transcript") continue;
        const s = Number(b.start);
        const e = Number(b.end);
        if (Number.isFinite(s)) minStart = Math.min(minStart, s);
        if (Number.isFinite(e)) maxEnd = Math.max(maxEnd, e);
      }
      if (Number.isFinite(minStart) && Number.isFinite(maxEnd) && maxEnd > minStart) {
        m.push({ pageIndex: i, minStart, maxEnd });
      }
    });
    return m;
  }, [pages]);

  const userOverrideUntilRef = useRef(0);
  const lastAutoFlippedToRef = useRef(-1);

  useEffect(() => {
    if (!audio?.playing) return;
    if (transcriptPageMap.length === 0) return;
    if (Date.now() < userOverrideUntilRef.current) return;
    const t = Number(audio.currentTime) || 0;
    const target = transcriptPageMap.find(
      (p) => t >= p.minStart - 0.15 && t <= p.maxEnd + 0.25
    );
    if (!target) return;
    if (target.pageIndex === pageIndex) return;
    if (target.pageIndex === lastAutoFlippedToRef.current) return;
    lastAutoFlippedToRef.current = target.pageIndex;
    setDirection(target.pageIndex > pageIndex ? 1 : -1);
    setPageIndex(target.pageIndex);
  }, [audio?.currentTime, audio?.playing, transcriptPageMap, pageIndex]);

  if (loading) {
    return (
      <div className="reader-root reader-shell" data-theme={theme} data-size={size}>
        <div className="h-[88vh] grid place-items-center px-6">
          <div className="flex flex-col items-center gap-5" data-testid="reader-loading">
            <motion.div
              className="relative h-24 w-20"
              animate={{ rotateY: [0, 180, 360] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              style={{ transformStyle: "preserve-3d", perspective: 600 }}
            >
              <div
                className="absolute inset-0 rounded-lg"
                style={{
                  background: "linear-gradient(155deg, #3A1B1B 0%, #6A2D2D 100%)",
                  boxShadow:
                    "0 14px 28px -8px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.1)",
                }}
              />
              <div
                className="absolute inset-0 rounded-lg grid place-items-center text-2xl"
                style={{ backfaceVisibility: "hidden" }}
              >
                📖
              </div>
            </motion.div>
            <div className="text-center">
              <p className="font-display text-[18px] text-parchment">Preparing your book…</p>
              <motion.p
                className="text-[12px] uppercase tracking-[0.25em] text-faded mt-1"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              >
                Lighting the lamps
              </motion.p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="reader-root reader-shell p-10" data-theme={theme} data-size={size}>
        <div className="max-w-[520px] mx-auto text-center mt-20 rounded-2xl border border-gold/25 p-8 bg-walnut/60 text-parchment">
          <p className="font-display text-xl mb-2">{error || "Book not found"}</p>
          <button
            onClick={() => navigate("/library")}
            className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gold text-ink font-semibold"
            data-testid="reader-back-to-library"
          >
            <Home className="h-4 w-4" /> Back to Library
          </button>
        </div>
      </div>
    );
  }

  // Guest reading experience — a guest reaches this page for every book
  // (see GuestAwareGate/LibraryPage), but the backend's own guest content
  // boundary already strips `chapters`/`content` for any priced book when
  // the caller is unauthenticated (see guest_content_boundary.py). A guest
  // opening a free book never hits this — `book.chapters` arrives full,
  // exactly like an authenticated student's reader. Reusing the same
  // rounded-card container the error state above uses, not inventing a new
  // one; the invitation continues the moment they were already in (this
  // book, this cover), rather than interrupting it with a paywall screen.
  const guestLocked = !isAuthenticated && !(book?.chapters?.length > 0);
  if (guestLocked) {
    return (
      <div className="reader-root reader-shell p-10" data-theme={theme} data-size={size}>
        <div className="max-w-[520px] mx-auto text-center mt-20 rounded-2xl border border-gold/25 p-8 bg-walnut/60 text-parchment" data-testid="reader-guest-locked">
          <p className="font-display text-xl mb-2">{book.title}</p>
          <p className="text-sm text-faded mb-1">This book is part of EduHub</p>
          <p className="text-sm text-faded">Sign in to keep reading</p>
          <button
            onClick={() => navigate(`/login?redirect=/library/read/${book.slug}`)}
            className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gold text-ink font-semibold"
            data-testid="reader-guest-locked-signin"
          >
            Sign In to Continue
          </button>
          <button
            onClick={() => navigate("/library")}
            className="mt-3 block w-full text-xs text-faded underline"
            data-testid="reader-guest-locked-back"
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  // Audit addition (P0 hardening, independent-release-audit pass) — an
  // AUTHENTICATED reader must never fall through to the broken "0/1 · The
  // End" shell (dead navigation, no content). Reachable if the P0 auth-
  // transport fix above still somehow produces a chapterless catalog entry
  // for this reader (e.g. a genuinely malformed backend document, or a
  // transient network failure mid-fetch) — this is a last-resort UI guard,
  // not a replacement for the root-cause fix. Same card language as the
  // guestLocked/error states above; `retryNonce` re-runs the load effect
  // in place (no remount, no shell flash — see the state's own comment).
  const contentUnavailable = isAuthenticated && !(book?.chapters?.length > 0);
  if (contentUnavailable) {
    return (
      <div className="reader-root reader-shell p-10" data-theme={theme} data-size={size}>
        <div className="max-w-[520px] mx-auto text-center mt-20 rounded-2xl border border-gold/25 p-8 bg-walnut/60 text-parchment" data-testid="reader-content-unavailable">
          <p className="font-display text-xl mb-2">{book.title}</p>
          <p className="text-sm text-faded">The pages are taking a moment to arrive.</p>
          <p className="text-sm text-faded">Check your connection and try again.</p>
          <button
            onClick={() => setRetryNonce((n) => n + 1)}
            className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gold text-ink font-semibold transition-transform active:scale-95"
            data-testid="reader-content-retry"
          >
            Try Again
          </button>
          <button
            onClick={() => navigate("/library")}
            className="mt-3 block w-full text-xs text-faded underline"
            data-testid="reader-content-back"
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  // Issue 2 fix — derive the rendered page defensively. `pages` can shrink
  // (viewport resize / orientation change, far more frequent on mobile)
  // before the clamp effect above has a chance to run, leaving a stale
  // `pageIndex` out of range for one render frame. Reading `pages[pageIndex]`
  // directly in that frame is `undefined`, and every content block below
  // gates on `currentPage && ...` — so that frame renders fully blank. The
  // effect above still syncs `pageIndex` state itself (other reads compare
  // against it directly); this only guards the value actually rendered.
  const safePageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const currentPage = pages[safePageIndex];
  const isCover = pageIndex === 0;
  const isSpread = shouldSpreadAt(pageIndex);
  const rightPage = isSpread ? pages[pageIndex + 1] : null;

  // Issue 1 fix — EduTalk Live Coach normally remounts per chapter (see the
  // `key` comment at its render site below); that is unchanged. But a page
  // turn INTO a new chapter must never remount — and therefore silently
  // unmount, closing the WebSocket and ending/refunding — a Live Coach
  // session that is currently "live". While a session is active the key
  // is pinned to its last value; the moment the session ends, the very
  // next chapter's key takes effect normally.
  const rawLiveCoachKey = currentPage ? `live-${currentPage.chapterIdx}` : "live-none";
  if (!hasActiveSession()) {
    liveCoachKeyRef.current = rawLiveCoachKey;
  }
  const liveCoachKey = liveCoachKeyRef.current ?? rawLiveCoachKey;

  return (
    <div
      className="reader-root reader-shell"
      data-theme={theme}
      data-size={size}
      data-reader-mode={mode}
      data-section={book.section}
      data-tier={book?.tier || "free"}
      data-spread={isSpread ? "true" : "false"}
      data-testid="reader-root"
      style={{ background: "var(--reader-bg)", minHeight: "100vh" }}
    >
      <WelcomeOverlay student={student} book={book} currentPage={pageIndex} />
      {/* Toolbar */}
      <div className="reader-toolbar">
        <div className="max-w-[1100px] mx-auto flex items-center gap-2 px-3 sm:px-5 py-2.5">
          <button
            onClick={() => navigate("/library")}
            aria-label="Back to library"
            data-testid="reader-exit"
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full text-[12px] font-semibold hover:bg-white/10 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Library</span>
          </button>
          <div className="min-w-0 flex-1 hidden md:block">
            <p className="truncate font-display text-[14px] text-parchment/90">
              {book.title}
            </p>
          </div>

          <button
            onClick={() => setTocOpen(true)}
            aria-label="Contents"
            data-testid="reader-toc-btn"
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
          >
            <List className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-0.5 rounded-full bg-black/30 px-1 py-0.5 border border-white/5">
            <button
              onClick={() => sizeDelta(-1)}
              className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
              aria-label="Smaller text"
              data-testid="reader-text-smaller"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="text-[10px] font-bold tracking-wider w-6 text-center text-parchment/70">
              {size.toUpperCase()}
            </span>
            <button
              onClick={() => sizeDelta(1)}
              className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
              aria-label="Bigger text"
              data-testid="reader-text-bigger"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            onClick={cycleTheme}
            aria-label={`Theme: ${theme}`}
            data-testid="reader-theme-toggle"
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMode((m) => (m === "premium" ? "minimal" : "premium"))}
            aria-label={`Reading mode: ${mode === "premium" ? "3D premium" : "Modern minimalist"}`}
            data-testid="reader-mode-toggle"
            data-mode={mode}
            title={mode === "premium" ? "Switch to minimalist mode" : "Switch to 3D premium mode"}
            className="h-9 px-2.5 inline-flex items-center gap-1 rounded-full hover:bg-white/10 transition-colors text-[10px] font-bold uppercase tracking-[0.18em]"
            style={{ color: mode === "premium" ? "#D4A843" : "var(--reader-muted)" }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{mode === "premium" ? "3D" : "Flat"}</span>
          </button>
          {isPremium && (
            <button
              onClick={() => setTurnSoundOn((s) => !s)}
              aria-label={turnSoundOn ? "Turn sound off" : "Turn sound on"}
              data-testid="reader-turn-sound-toggle"
              title={turnSoundOn ? "Page-turn sound ON" : "Page-turn sound OFF"}
              className="h-9 w-9 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
              style={{ color: turnSoundOn ? "#D4A843" : "var(--reader-muted)" }}
            >
              {turnSoundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          )}
          <button
            onClick={toggleBookmark}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark page"}
            data-testid="reader-bookmark"
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
            style={{ color: bookmarked ? "#D4A843" : undefined }}
          >
            {bookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </button>
        </div>
        <div className="reader-progress" aria-hidden style={{ position: "relative" }}>
          <span className="reader-progress__fill" style={{ width: `${progress}%` }} />
          {chapterTicks.map((t, i) => (
            <span
              key={`tick-${i}`}
              aria-hidden
              style={{
                position: "absolute",
                left: `${t}%`,
                top: 0,
                bottom: 0,
                width: 1,
                background: "rgba(212,168,67,0.55)",
                pointerEvents: "none",
              }}
              data-testid={`reader-chapter-tick-${i}`}
            />
          ))}
          {pageIndex > 0 && book?.readingMinutes ? (
            <div className="reader-progress-meta" data-testid="reader-progress-meta">
              {Math.max(
                1,
                Math.round(
                  (Number(book.readingMinutes) || 0) *
                    Math.max(0, 1 - progress / 100)
                )
              )}{" "}
              min left
            </div>
          ) : null}
        </div>
      </div>

      {/* Book stage */}
      <div className="book-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="flip-wrap" style={{ transformStyle: "preserve-3d" }}>
          {!isCover && (
            <div
              className="book-spine"
              aria-hidden="true"
              data-testid="reader-book-spine"
              /*
                v9.6 — Premium UI cleanup: soften the book spine.
                Previously the .book-spine rule (in reader.css) painted a
                near-black vertical bar with strong inset shadows that read
                as a harsh black line slicing through the book. We inline a
                gentler "page fold shadow" treatment here so the 3D book
                feeling is preserved but the dominance is dialled way down.
                - softer chocolate→amber→chocolate gradient (no pure black)
                - lower opacity overall
                - thinner footprint
                - pointer-events stay none (kept from the base rule)
                - z-index pushed below page content so nothing it overlaps
                  becomes unclickable
                The base CSS rule remains intact; this is purely an
                inline override scoped to the reader spine element.
              */
              style={{
                opacity: 0.45,
                width: 10,
                background:
                  "linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(58,30,16,0.55) 35%, rgba(82,46,22,0.62) 50%, rgba(58,30,16,0.55) 65%, rgba(0,0,0,0) 100%)",
                boxShadow:
                  "0 12px 26px -14px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.18)",
                borderRadius: 2,
                zIndex: 0,
                pointerEvents: "none",
                mixBlendMode: "multiply",
              }}
            />
          )}
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={isSpread ? `spread-${pageIndex}` : `p-${pageIndex}`}
              custom={direction}
              className="page-flip-shadow page-flip-curl"
              initial={
                mode === "minimal"
                  ? { x: direction > 0 ? 60 : -60, opacity: 0 }
                  : {
                      rotateY: direction > 0 ? 55 : -55,
                      x: direction > 0 ? 40 : -40,
                      opacity: 0,
                    }
              }
              animate={{ rotateY: 0, x: 0, opacity: 1 }}
              exit={
                mode === "minimal"
                  ? { x: direction > 0 ? -60 : 60, opacity: 0 }
                  : {
                      rotateY: direction > 0 ? -55 : 55,
                      x: direction > 0 ? -40 : 40,
                      opacity: 0,
                    }
              }
              transition={
                mode === "minimal"
                  ? { duration: 0.28, ease: [0.2, 0.9, 0.3, 1] }
                  : { duration: 0.55, ease: [0.22, 1, 0.36, 1] }
              }
              style={{
                transformStyle: "preserve-3d",
                transformOrigin: "left center",
              }}
            >
              {isCover ? (
                <BookCover book={book} minutes={book.readingMinutes} onBegin={() => go(1)} />
              ) : isSpread && rightPage ? (
                <div
                  className="book-spread-wrap"
                  style={{
                    display: "flex",
                    gap: 0,
                    alignItems: "stretch",
                    justifyContent: "center",
                  }}
                  data-testid="reader-spread"
                >
                  {renderContentPage(
                    currentPage,
                    pageRef,
                    pages.length,
                    pageIndex,
                    book,
                    isPremium,
                    true
                  )}
                  {renderContentPage(
                    rightPage,
                    pageRefRight,
                    pages.length,
                    pageIndex + 1,
                    book,
                    isPremium,
                    false
                  )}
                </div>
              ) : (
                renderContentPage(
                  currentPage,
                  pageRef,
                  pages.length,
                  pageIndex,
                  book,
                  isPremium,
                  null
                )
              )}
            </motion.div>
          </AnimatePresence>

          <button
            onClick={() => go(-1)}
            disabled={pageIndex === 0}
            aria-label="Previous page"
            data-testid="reader-prev"
            className="hidden md:grid place-items-center absolute left-[calc(50%-420px)] top-1/2 -translate-y-1/2 h-12 w-12 rounded-full border border-white/10 bg-black/30 text-parchment backdrop-blur hover:bg-gold/20 hover:text-gold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={() => go(1)}
            disabled={pageIndex >= pages.length - 1}
            aria-label="Next page"
            data-testid="reader-next"
            className="hidden md:grid place-items-center absolute right-[calc(50%-420px)] top-1/2 -translate-y-1/2 h-12 w-12 rounded-full border border-white/10 bg-black/30 text-parchment backdrop-blur hover:bg-gold/20 hover:text-gold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Mobile footer nav */}
      <div
        className="md:hidden sticky bottom-0 z-10 px-4 py-3 flex items-center justify-between gap-2"
        style={{
          background: "color-mix(in srgb, var(--reader-bg) 85%, transparent)",
          backdropFilter: "blur(10px)",
        }}
      >
        <button
          onClick={() => go(-1)}
          disabled={pageIndex === 0}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full py-2.5 text-[12px] font-semibold border border-white/10 text-parchment disabled:opacity-30"
          data-testid="reader-prev-mobile"
          style={{ color: "var(--reader-ink)" }}
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </button>
        <span
          className="text-[11px] font-bold tracking-wider opacity-70"
          style={{ color: "var(--reader-muted)" }}
        >
          {pageIndex}/{totalContent}
        </span>
        <button
          onClick={() => go(1)}
          disabled={pageIndex >= pages.length - 1}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full py-2.5 text-[12px] font-semibold border"
          data-testid="reader-next-mobile"
          style={{
            background:
              pageIndex >= pages.length - 1
                ? "rgba(0,0,0,0.2)"
                : "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
            color: pageIndex >= pages.length - 1 ? "var(--reader-muted)" : "#1a1420",
            borderColor: "transparent",
          }}
        >
          {pageIndex >= pages.length - 1 ? "The End" : "Next"}
          {pageIndex < pages.length - 1 && <ChevronRight className="h-4 w-4" />}
        </button>
      </div>

      <TocDrawer
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        book={book}
        pages={tocPages}
        pageIndex={tocActiveIndex}
        onJump={jumpTo}
      />

      <AnimatePresence>
        {finished && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 grid place-items-center pointer-events-none px-4"
          >
            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.9 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 20, opacity: 0 }}
              transition={{ type: "spring", damping: 20 }}
              onAnimationComplete={() => {
                setTimeout(() => setFinished(false), 3200);
              }}
              className="finish-card pointer-events-auto rounded-2xl border border-gold/35 px-5 py-4 max-w-[340px] text-center"
              style={{
                background: isPremium
                  ? `linear-gradient(155deg, ${book.accent || "#2D1F3E"}, #1A1420)`
                  : "linear-gradient(155deg, #2D1F3E, #1A1420)",
                boxShadow: "0 20px 60px rgba(212,168,67,0.3)",
                color: "#F4EAD0",
              }}
              data-testid="reader-finish-card"
            >
              <div
                className="mx-auto mb-2 h-10 w-10 grid place-items-center rounded-full"
                style={{
                  background: "linear-gradient(135deg,#FFE19A,#D4A843)",
                  color: "#1a1420",
                }}
              >
                <Check className="h-5 w-5" strokeWidth={3} />
              </div>
              <p className="font-display text-[17px] leading-tight">You finished the book</p>
              {isAuthenticated ? (
                pointsEarned != null ? (
                  <p className="mt-1 text-sm inline-flex items-center gap-1.5 text-gold">
                    <Sparkles className="h-4 w-4" /> +{pointsEarned} points earned
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-faded">Points will appear in your stats</p>
                )
              ) : (
                <p className="mt-1 text-xs text-faded">Sign in to earn points next time</p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* EduTalk floating launcher — single shell-level mount.
          Self-hides when EduTalk is disabled / student unauthenticated /
          cover page. Skip on non-content pages.
          PHASE 3 GUARD: only render on the LAST page of the chapter so the
          launcher does not pop in mid-chapter. `isLastOfChapter` is set by
          the page builder above (subIdx === subs.length - 1). */}
      {currentPage && currentPage.type === "content" && (
        /* EduTalk launcher is visible on EVERY content page of the chapter.
           key={chapterIdx} keeps the component mounted across page flips
           within the same chapter so config is not re-fetched per page. */
        <EduTalkLauncher
          key={currentPage.chapterIdx}
          bookSlug={book?.slug}
          bookTitle={book?.title}
          chapterIdx={currentPage.chapterIdx}
          chapterTitle={currentPage.chapterTitle}
          pageIdx={currentPage.subIdx}
          visibleText={(currentPage.blocks || []).map((b) => b?.text || "").join("\n").slice(0, 4500)}
          hideOwnFab
          onFabState={onEduTalkFabState}
        />
      )}
      {/* EduTalk Live Coach — NEW real-time speaking practice. Mounted next to
          (but fully separate from) the EduTalk assistant + narration player.
          Self-hides unless admin-enabled AND Gemini is configured.
          key is chapter-scoped (fresh config/state per chapter) EXCEPT
          while a session is "live" — see `liveCoachKey` above, which pins
          it so a page turn can never silently end an in-progress session. */}
      {currentPage && currentPage.type === "content" && (
        <EduTalkLiveCoach
          key={liveCoachKey}
          bookSlug={book?.slug}
          bookTitle={book?.title}
          bookTier={book?.tier || "free"}
          chapterIdx={currentPage.chapterIdx}
          chapterTitle={currentPage.chapterTitle}
          visibleText={(currentPage.blocks || []).map((b) => b?.text || "").join("\n").slice(0, 4500)}
          hideOwnFab
          onFabState={onLiveCoachFabState}
        />
      )}
      {/* Coach Pack v3 — additive overlay. Renders nothing when student is
          unauthenticated or bookSlug is missing. Failure-safe (ErrorBoundary
          inside the component) — reader cannot crash because of Coach Pack. */}
      {!isBootstrapping && book?.slug && currentPage && currentPage.type === "content" && (
        <CoachPackOverlay
          bookSlug={book.slug}
          bookTitle={book?.title}
          bookTier={book?.tier || "free"}
          chapterIdx={currentPage.chapterIdx}
          chapterTitle={currentPage.chapterTitle}
          visibleText={(currentPage.blocks || []).map((b) => b?.text || "").join("\n").slice(0, 4500)}
          totalChapters={Array.isArray(book?.chapters) ? book.chapters.length : 0}
          chapterCompleted={!!currentPage.isLastOfChapter}
        />
      )}
    </div>
  );
}

/**
 * renderContentPage — shared renderer for both single and spread mode.
 * `leftSide`: true = left page of spread, false = right, null = single.
 * Keeps ChapterBlocks intact so AudioPlayerContext / ExerciseBlock
 * continue to work unchanged.
 */
function renderContentPage(page, ref, totalPages, flatIdx, book, isPremium, leftSide) {
  if (!page || page.type !== "content") return null;
  const isLastOfBook = flatIdx === totalPages - 1;
  const isChapterOpener = page.isFirstOfChapter;
  const accent = book?.accent || "#D4A843";

  return (
    <article
      ref={ref}
      className={`book-page ${isChapterOpener && page.chapterIdx === 0 ? "is-intro" : ""}`}
      data-testid={`reader-page-${flatIdx}`}
      data-sub-page={page.subIdx}
      data-chapter-idx={page.chapterIdx}
      data-is-chapter-opener={isChapterOpener ? "true" : "false"}
      data-spread-side={leftSide === true ? "left" : leftSide === false ? "right" : "single"}
      aria-label={page.chapterTitle}
      style={
        leftSide === true
          ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 }
          : leftSide === false
          ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }
          : undefined
      }
    >
      {isChapterOpener && (
        <header>
          {isPremium && book?.coverImage && (
            <div
              aria-hidden
              data-testid="reader-chapter-illustration"
              style={{
                height: 88,
                marginBottom: 16,
                borderRadius: 4,
                backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 100%), url(${book.coverImage})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                boxShadow: `inset 0 -1px 0 ${accent}55`,
              }}
            />
          )}
          <p
            className="text-[10px] uppercase tracking-[0.25em] mb-1"
            style={{ color: "var(--reader-muted)" }}
          >
            Chapter {page.chapterIdx + 1} · {book?.section || "story"}
            {page.subPagesInChapter > 1 && (
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                · page {page.subIdx + 1} of {page.subPagesInChapter}
              </span>
            )}
          </p>
          <h2
            style={
              isPremium
                ? {
                    borderBottom: `1px solid ${accent}55`,
                    paddingBottom: "0.3em",
                  }
                : undefined
            }
          >
            {page.chapterTitle}
          </h2>
        </header>
      )}

      {!isChapterOpener && (
        <p
          className="text-[10px] uppercase tracking-[0.25em] mb-1"
          style={{ color: "var(--reader-muted)", opacity: 0.75 }}
        >
          {page.chapterTitle} · page {page.subIdx + 1} of {page.subPagesInChapter}
        </p>
      )}

      <div
        className="reader-page-body"
        data-drop-cap={isChapterOpener ? "true" : "false"}
        style={
          isChapterOpener
            ? {
                // Accent drop-cap on the first paragraph of every chapter opener
                // via a scoped inline style block that targets the first <p>.
              }
            : undefined
        }
      >
        {isChapterOpener && (
          <style>{`
            [data-testid="reader-page-${flatIdx}"] .reader-page-body > p:first-of-type::first-letter,
            [data-testid="reader-page-${flatIdx}"] .reader-page-body .markdown-body > p:first-of-type::first-letter {
              color: ${isPremium ? accent : "var(--reader-accent, " + accent + ")"};
              font-weight: 600;
            }
          `}</style>
        )}
        <ChapterBlocks blocks={page.blocks} bookSlug={book?.slug} bookTier={book?.tier} chapterIdx={page.chapterIdx} />
      </div>

      {isLastOfBook && (
        <div
          className="mt-8 pt-6 text-center"
          style={{ borderTop: "1px solid var(--reader-rule)" }}
        >
          <p
            className="text-[11px] tracking-[0.28em] uppercase mb-2"
            style={{ color: "var(--reader-muted)" }}
          >
            ~ Fin ~
          </p>
          <p style={{ color: "var(--reader-muted)", fontStyle: "italic" }}>
            Thank you for reading.
          </p>
        </div>
      )}
    </article>
  );
}
