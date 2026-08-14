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
} from "lucide-react";
import { getBookBySlug } from "../books/booksService";
import { isUnlocked } from "../books/purchaseService";
import { useAuth } from "../../../context/AuthContext";
import { completeLessonRequest } from "../api";
import BookCover from "./BookCover";
import ChapterBlocks from "./ChapterBlocks";
import TocDrawer from "./TocDrawer";
import {
  BookAudioProvider,
  PersistentMiniPlayer,
} from "./AudioPlayerContext";
import "./reader.css";
import "../library-theme.css";

const THEMES = ["light", "sepia", "dark"];
const SIZES = ["sm", "md", "lg", "xl"];

function bookmarkKey(slug) {
  return `eduhub_book_bm_${slug}`;
}

export default function ReaderPage() {
  return (
    <BookAudioProvider>
      <ReaderPageInner />
      <PersistentMiniPlayer />
    </BookAudioProvider>
  );
}

function ReaderPageInner() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, student } = useAuth();

  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [pageIndex, setPageIndex] = useState(0); // 0 = cover
  const [direction, setDirection] = useState(1);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("eduhub_reader_theme") || "sepia"
  );
  const [size, setSize] = useState(
    () => localStorage.getItem("eduhub_reader_size") || "md"
  );
  const [tocOpen, setTocOpen] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pointsEarned, setPointsEarned] = useState(null);
  const completionFiredRef = useRef(false);

  // Body theme side-effects + v7.9.8 section-aware data attr so
  // reader.css (or future per-section skins) can re-style story vs
  // conversation vs exercise without touching the component tree.
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

  // Load the book
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getBookBySlug(slug)
      .then((b) => {
        if (!alive) return;
        if (!b) {
          setError("We couldn't find that book. It may have been moved.");
          setBook(null);
          return;
        }
        // Gate paid books: redirect back to library so the Purchase modal
        // is shown there (cannot be bypassed via direct URL).
        const price = Number(b.price) || 0;
        if (price > 0 && !isUnlocked(student?.studentId, b, student?.portalData)) {
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
  }, [slug, student?.studentId, navigate]);

  // Load bookmark
  useEffect(() => {
    if (!book) return;
    try {
      const raw = localStorage.getItem(bookmarkKey(book.slug));
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v?.pageIndex === "number") {
          setPageIndex(v.pageIndex);
          setBookmarked(true);
        }
      }
    } catch {
      /* ignore */
    }
  }, [book]);

  // Persist theme / size
  useEffect(() => {
    localStorage.setItem("eduhub_reader_theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("eduhub_reader_size", size);
  }, [size]);

  // Pages = cover (0) + each chapter
  const pages = useMemo(() => {
    if (!book) return [];
    const chapterPages = (book.chapters || []).map((c) => ({
      type: "chapter",
      title: c.title,
      blocks: c.blocks,
    }));
    return [{ type: "cover" }, ...chapterPages];
  }, [book]);

  const totalContent = Math.max(1, pages.length - 1);
  const progress = useMemo(() => {
    if (pageIndex <= 0) return 0;
    return Math.min(100, Math.round((pageIndex / totalContent) * 100));
  }, [pageIndex, totalContent]);

  // Cycle themes
  const cycleTheme = () => {
    const i = THEMES.indexOf(theme);
    setTheme(THEMES[(i + 1) % THEMES.length]);
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Palette;

  const go = useCallback(
    (delta) => {
      setDirection(delta > 0 ? 1 : -1);
      setPageIndex((i) => {
        const next = Math.max(0, Math.min(pages.length - 1, i + delta));
        return next;
      });
    },
    [pages.length]
  );

  const jumpTo = useCallback((i) => {
    setDirection(i > 0 ? 1 : -1);
    setPageIndex(i);
    setTocOpen(false);
  }, []);

  // Arrow keys
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

  // Touch / swipe
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

  // Scroll to top on page change
  const pageRef = useRef(null);
  useEffect(() => {
    if (pageRef.current) pageRef.current.scrollTo({ top: 0, behavior: "instant" });
  }, [pageIndex]);

  // Finish detection + call completeLesson API once
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

  // Bookmark toggle
  const toggleBookmark = () => {
    if (!book) return;
    if (bookmarked) {
      localStorage.removeItem(bookmarkKey(book.slug));
      setBookmarked(false);
    } else {
      localStorage.setItem(
        bookmarkKey(book.slug),
        JSON.stringify({ pageIndex, ts: Date.now() })
      );
      setBookmarked(true);
    }
  };

  const sizeDelta = (d) => {
    const i = SIZES.indexOf(size);
    const ni = Math.max(0, Math.min(SIZES.length - 1, i + d));
    setSize(SIZES[ni]);
  };

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
                  background:
                    "linear-gradient(155deg, #3A1B1B 0%, #6A2D2D 100%)",
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

  const currentPage = pages[pageIndex];
  const isCover = pageIndex === 0;

  return (
    <div
      className="reader-root reader-shell"
      data-theme={theme}
      data-size={size}
      data-section={book.section}
      data-testid="reader-root"
      style={{ background: "var(--reader-bg)", minHeight: "100vh" }}
    >
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
            onClick={toggleBookmark}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark page"}
            data-testid="reader-bookmark"
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-white/10 transition-colors"
            style={{ color: bookmarked ? "#D4A843" : undefined }}
          >
            {bookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </button>
        </div>
        <div className="reader-progress" aria-hidden>
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Book stage */}
      <div className="book-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="flip-wrap" style={{ transformStyle: "preserve-3d" }}>
          {/* v7.6: visible physical spine — stays fixed while pages turn */}
          {!isCover && (
            <div className="book-spine" aria-hidden="true" data-testid="reader-book-spine" />
          )}
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={pageIndex}
              custom={direction}
              className="page-flip-shadow page-flip-curl"
              initial={{
                rotateY: direction > 0 ? 55 : -55,
                x: direction > 0 ? 40 : -40,
                opacity: 0,
              }}
              animate={{ rotateY: 0, x: 0, opacity: 1 }}
              exit={{
                rotateY: direction > 0 ? -55 : 55,
                x: direction > 0 ? -40 : 40,
                opacity: 0,
              }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformStyle: "preserve-3d", transformOrigin: "left center" }}
            >
              {isCover ? (
                <BookCover
                  book={book}
                  minutes={book.readingMinutes}
                  onBegin={() => go(1)}
                />
              ) : (
                <article
                  ref={pageRef}
                  className={`book-page ${pageIndex === 1 ? "is-intro" : ""}`}
                  data-testid={`reader-page-${pageIndex}`}
                  aria-label={currentPage.title}
                >
                  <header>
                    <p
                      className="text-[10px] uppercase tracking-[0.25em] mb-1"
                      style={{ color: "var(--reader-muted)" }}
                    >
                      Chapter {pageIndex} of {totalContent} · {book.section}
                    </p>
                    <h2>{currentPage.title}</h2>
                  </header>
                  <ChapterBlocks blocks={currentPage.blocks} />
                  {pageIndex === pages.length - 1 && (
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
              )}
            </motion.div>
          </AnimatePresence>

          {/* Desktop page turn arrows */}
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
            disabled={pageIndex === pages.length - 1}
            aria-label="Next page"
            data-testid="reader-next"
            className="hidden md:grid place-items-center absolute right-[calc(50%-420px)] top-1/2 -translate-y-1/2 h-12 w-12 rounded-full border border-white/10 bg-black/30 text-parchment backdrop-blur hover:bg-gold/20 hover:text-gold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Mobile footer nav */}
      <div className="md:hidden sticky bottom-0 z-10 px-4 py-3 flex items-center justify-between gap-2"
        style={{ background: "color-mix(in srgb, var(--reader-bg) 85%, transparent)", backdropFilter: "blur(10px)" }}
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
        <span className="text-[11px] font-bold tracking-wider opacity-70" style={{ color: "var(--reader-muted)" }}>
          {pageIndex}/{totalContent}
        </span>
        <button
          onClick={() => go(1)}
          disabled={pageIndex === pages.length - 1}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full py-2.5 text-[12px] font-semibold border"
          data-testid="reader-next-mobile"
          style={{
            background: pageIndex === pages.length - 1 ? "rgba(0,0,0,0.2)" : "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
            color: pageIndex === pages.length - 1 ? "var(--reader-muted)" : "#1a1420",
            borderColor: "transparent",
          }}
        >
          {pageIndex === pages.length - 1 ? "The End" : "Next"}
          {pageIndex !== pages.length - 1 && <ChevronRight className="h-4 w-4" />}
        </button>
      </div>

      {/* TOC */}
      <TocDrawer
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        book={book}
        pages={pages}
        pageIndex={pageIndex}
        onJump={jumpTo}
      />

      {/* Completion toast */}
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
                background: "linear-gradient(155deg, #2D1F3E, #1A1420)",
                boxShadow: "0 20px 60px rgba(212,168,67,0.3)",
                color: "#F4EAD0",
              }}
              data-testid="reader-finish-card"
            >
              <div className="mx-auto mb-2 h-10 w-10 grid place-items-center rounded-full"
                style={{ background: "linear-gradient(135deg,#FFE19A,#D4A843)", color: "#1a1420" }}
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
    </div>
  );
}
