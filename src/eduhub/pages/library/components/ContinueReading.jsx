import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BookmarkCheck, Headphones, Play } from "lucide-react";

/**
 * ContinueReading — surfaces books that the student has either:
 *   • bookmarked (`localStorage.eduhub_book_bm_<slug>`), OR
 *   • partially listened to (`localStorage.eduhub_reader_audio_progress`)
 * sorted by most-recent activity. Renders nothing when both are empty.
 *
 * Tapping a card jumps directly to the reader for that book.
 *
 * Props:
 *   • catalog         — full normalized book catalog (each entry has
 *                        slug, title, subtitle, coverImage, coverEmoji)
 *   • onResume(book)  — handler called with the picked book object
 */
const BOOKMARK_KEY_PREFIX = "eduhub_book_bm_";
const AUDIO_PROGRESS_KEY = "eduhub_reader_audio_progress";

function readBookmarks(catalog) {
  const out = [];
  if (!Array.isArray(catalog)) return out;
  for (const b of catalog) {
    try {
      const raw = localStorage.getItem(BOOKMARK_KEY_PREFIX + b.slug);
      if (!raw) continue;
      const v = JSON.parse(raw);
      if (typeof v?.pageIndex === "number") {
        out.push({
          book: b,
          page: v.pageIndex,
          ts: Number(v.ts) || 0,
          source: "bookmark",
        });
      }
    } catch {
      /* ignore corrupt entries */
    }
  }
  return out;
}

function readAudioProgress(catalog) {
  const out = [];
  try {
    const raw = localStorage.getItem(AUDIO_PROGRESS_KEY);
    if (!raw) return out;
    const map = JSON.parse(raw);
    if (!map || typeof map !== "object") return out;
    // Match the audio URL back to a book in the catalog by checking
    // every chapter's audio block. A loose substring match is plenty.
    for (const [url, info] of Object.entries(map)) {
      if (!url || !info?.t) continue;
      const matched = (catalog || []).find((b) =>
        (b.chapters || []).some((c) =>
          (c.blocks || []).some(
            (blk) => blk.type === "audio" && blk.text && url.includes(blk.text)
          )
        )
      );
      if (matched) {
        out.push({
          book: matched,
          audioSeconds: Number(info.t) || 0,
          ts: Number(info.ts) || 0,
          source: "audio",
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function fmtAudio(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function ContinueReading({ catalog, onResume }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!Array.isArray(catalog) || catalog.length === 0) {
      setItems([]);
      return;
    }
    const all = [...readBookmarks(catalog), ...readAudioProgress(catalog)];
    // De-duplicate by slug, prefer the most recent ts.
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
        .slice(0, 8)
    );
  }, [catalog]);

  if (items.length === 0) return null;

  return (
    <section
      className="continue-reading mt-3 mb-2"
      data-testid="continue-reading"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-display text-[15px] text-parchment">
          Continue where you left off
        </h3>
        <p className="text-[10px] uppercase tracking-[0.22em] text-parchment/50">
          {items.length} book{items.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="continue-reading__strip flex gap-3 overflow-x-auto pb-1">
        <AnimatePresence initial={false}>
          {items.map((it, i) => {
            const b = it.book;
            return (
              <motion.button
                key={b.slug}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                whileHover={{ y: -3, scale: 1.02 }}
                onClick={() => onResume?.(b)}
                className="continue-reading__card group relative flex h-[88px] flex-none items-center gap-3 rounded-xl px-3 pr-4 text-left text-parchment focus:outline-none"
                style={{
                  width: "min(280px, 78vw)",
                  background:
                    "linear-gradient(135deg, rgba(45,31,62,0.85), rgba(20,14,28,0.92))",
                  border: "1px solid rgba(212,168,67,0.28)",
                  boxShadow:
                    "0 14px 28px -16px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)",
                  backdropFilter: "blur(8px)",
                }}
                data-testid={`continue-reading-card-${i}`}
              >
                <span
                  aria-hidden
                  className="grid h-[64px] w-[48px] flex-none place-items-center rounded-md text-[20px]"
                  style={{
                    background: b.coverImage
                      ? `url("${b.coverImage}") center/cover`
                      : b.coverGradient ||
                        "linear-gradient(135deg, rgba(212,168,67,0.25), rgba(74,58,106,0.4))",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 6px 14px -8px rgba(0,0,0,0.55)",
                  }}
                >
                  {!b.coverImage && (b.coverEmoji || "📖")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 font-display text-[13.5px] leading-tight text-parchment">
                    {b.title}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-parchment/55">
                    {b.subtitle || b.author || ""}
                  </p>
                  <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-gold">
                    {it.source === "audio" ? (
                      <>
                        <Headphones className="h-3 w-3" />
                        Resume {fmtAudio(it.audioSeconds)}
                      </>
                    ) : (
                      <>
                        <BookmarkCheck className="h-3 w-3" />
                        Page {it.page + 1}
                      </>
                    )}
                  </p>
                </div>
                <span
                  className="grid h-8 w-8 flex-none place-items-center rounded-full text-ink"
                  style={{
                    background:
                      "linear-gradient(135deg, #FFE19A, #D4A843 60%, #9C7A2C)",
                    boxShadow: "0 8px 16px -8px rgba(212,168,67,0.6)",
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
