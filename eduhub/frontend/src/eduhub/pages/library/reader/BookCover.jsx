import { useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Clock, Sparkles, Headphones, Video } from "lucide-react";
import SheetBadge from "../components/SheetBadge.jsx";
import StylizedCover from "./StylizedCover.jsx";

/**
 * BookCover — the first page of the in-reader flip book.
 *
 * Layout (v7.8):
 *   ┌─────────────────────────────────┐
 *   │ [section]           [min read]  │   ← top chips
 *   │                                 │
 *   │         cover artwork           │   ← 62% of height, rounded,
 *   │        (image or emoji)         │      realistic drop shadow
 *   │                                 │
 *   │ ─────── parchment panel ─────── │
 *   │ Title                           │
 *   │ Subtitle · Level                │   ← metadata band that blends
 *   │                                 │      with the native dark-academia
 *   │ Author             Open Book →  │      sepia / dark / light themes
 *   └─────────────────────────────────┘
 */
export default function BookCover({ book, onBegin, minutes }) {
  const [imgFailed, setImgFailed] = useState(false);
  const hasImage = !!book.coverImage && !imgFailed;

  // v9.4 — Premium foil overlay now driven exclusively by the
  // Author-selected visual treatment badge. The legacy `price > 0`
  // signal has been removed: a 0-pt promo book authored as "premium"
  // now correctly shows the foil, and a 200-pt book authored as
  // "standard" no longer over-styles. Pricing / entitlement remains
  // unaffected — it is still read from `book.price` elsewhere.
  const tier = String(book?.tier || '').toLowerCase();
  const isPremiumTier = tier === 'premium' || tier === 'limited';

  // v7.9.6 — derive the cover content-type icon/label. Honour the
  // optional `contentType` sheet override if present, otherwise scan
  // the resolved chapter blocks for audio/video/embed.
  const contentType = (book.contentType || book._contentType || scanBookType(book));
  const CT_ICON = contentType === "audio" ? Headphones
               : contentType === "video" ? Video
               : BookOpen;
  const CT_LABEL = contentType === "audio" ? "Audio"
                : contentType === "video" ? "Video"
                : "Text";

  return (
    <motion.div
      initial={{ opacity: 0, rotateY: 20, y: 30 }}
      animate={{ opacity: 1, rotateY: 0, y: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      className="book-cover book-cover--v78"
      data-testid="reader-cover"
      data-has-image={hasImage ? "true" : "false"}
      style={{
        // Falls back to the book's gradient when no image is provided.
        background: book.coverGradient,
      }}
    >
      {/* Subtle foil outline that wraps the whole cover */}
      <div className="book-cover-foil" aria-hidden />

      {/* v10 (cinematic) — Premium / Limited tier foil overlay.
          Pure CSS effect (see reader-cinematic.css). Rendered only when
          the book object itself signals a paid tier — no fallback data,
          no mocking; reads directly from Author-Studio-fed `book.tier`
          and `book.price`. */}
      {isPremiumTier && (
        <div
          className="book-cover__premium-foil"
          data-tier={tier === 'limited' ? 'limited' : 'premium'}
          aria-hidden
          data-testid="reader-cover-premium-foil"
        />
      )}

      {/* ─── TOP CHIPS ─────────────────────────────────────────────── */}
      <div className="book-cover__chips" style={{ zIndex: 4 }}>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]"
          style={{
            background: "rgba(0,0,0,0.45)",
            color: book.accent || "#F4EAD0",
            border: `1px solid ${book.accent || "#F4EAD0"}55`,
            backdropFilter: "blur(6px)",
          }}
        >
          <BookOpen className="h-3 w-3" />
          {book.section === "exercise"
            ? "Exercise"
            : book.section === "conversation"
            ? "Conversation"
            : "Story"}
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-semibold tracking-wider"
          style={{
            background: "rgba(0,0,0,0.45)",
            color: "#f4ead0cc",
            backdropFilter: "blur(6px)",
          }}
        >
          <Clock className="h-3 w-3" />
          {minutes} min read
        </span>
        {/* v7.9.6 — auto-detected content-type chip (audio / video / text) */}
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]"
          style={{
            background: "rgba(0,0,0,0.45)",
            color: book.accent || "#F4EAD0",
            border: `1px solid ${book.accent || "#F4EAD0"}55`,
            backdropFilter: "blur(6px)",
          }}
          data-testid="reader-cover-content-type"
          data-content-type={contentType}
        >
          <CT_ICON className="h-3 w-3" />
          {CT_LABEL}
        </span>
      </div>

      {/* ─── ARTWORK PANEL — the actual "cover" ─────────────────────── */}
      <motion.figure
        className="book-cover__art"
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        data-testid="reader-cover-art"
      >
        {hasImage ? (
          <img
            src={book.coverImage}
            alt={`${book.title} cover`}
            className="book-cover__art-img"
            draggable={false}
            data-testid="reader-cover-image"
            loading="eager"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <StylizedCover
            title={book.title}
            section={book.section}
            gradient={book.coverGradient}
            accent={book.accent}
            emoji={book.coverEmoji}
            testid="reader-cover-stylized"
          />
        )}
        {/* glossy sheen that sweeps across the artwork on entry */}
        <span className="book-cover__art-sheen" aria-hidden />
        {/* sheet-driven badge — sits on the artwork so the animation stands out */}
        {book.badge && (
          <SheetBadge
            label={book.badge}
            size="md"
            className="book-cover__art-badge"
            testid="reader-cover-badge"
          />
        )}
      </motion.figure>

      {/* ─── METADATA PANEL — blends with the active theme ──────────── */}
      <div className="book-cover__panel" style={{ zIndex: 4 }}>
        <h1
          className="book-cover__title"
          data-testid="reader-book-title"
        >
          {book.title}
        </h1>
        {book.subtitle && (
          <p className="book-cover__subtitle">{book.subtitle}</p>
        )}
        <div className="book-cover__meta-row">
          <div className="book-cover__author-block">
            <p className="book-cover__author-label">Author</p>
            <p className="book-cover__author-name">{book.author}</p>
          </div>
          {book.level && (
            <span className="book-cover__level">{book.level}</span>
          )}
          <motion.button
            whileHover={{ y: -2, scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={onBegin}
            data-testid="reader-begin-btn"
            className="book-cover__cta"
          >
            <Sparkles className="h-4 w-4" />
            Open the Book
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * scanBookType — v7.9.6 fallback for reader covers that receive a book
 * which wasn't run through booksService's normalizer (e.g. legacy path).
 * Mirrors detectContentType() but operates on whatever chapter shape
 * is already on the book object.
 */
function scanBookType(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  let hasAudio = false;
  let hasVideo = false;
  for (const ch of chapters) {
    const blocks = Array.isArray(ch?.blocks) ? ch.blocks : [];
    for (const blk of blocks) {
      const t = String(blk?.type || "").toLowerCase();
      if (t === "audio" || t === "transcript") hasAudio = true;
      else if (t === "video" || t === "embed") hasVideo = true;
    }
  }
  if (hasAudio) return "audio";
  if (hasVideo) return "video";
  return "text";
}
