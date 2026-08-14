/**
 * StudioPreview — live-preview pane that reuses ChapterBlocks + BookCover
 * from the reader, so "what author sees" === "what student sees".
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, BookOpen } from "lucide-react";
import BookCover from "../eduhub/pages/library/reader/BookCover";
import ChapterBlocks from "../eduhub/pages/library/reader/ChapterBlocks";
import { BookAudioProvider } from "../eduhub/pages/library/reader/AudioPlayerContext";
import "../eduhub/pages/library/reader/reader.css";
import "../eduhub/pages/library/library-theme.css";

export default function StudioPreview({ book }) {
  const [idx, setIdx] = useState(0);

  const pages = useMemo(() => {
    if (!book) return [];
    return [
      { type: "cover" },
      ...(book.chapters || []).map((c) => ({ type: "chapter", title: c.title, blocks: c.blocks })),
    ];
  }, [book]);

  if (!book) {
    return (
      <div className="rounded-2xl border border-dashed border-parchment/15 p-8 text-center text-faded text-[12px]"
           data-testid="studio-preview-empty">
        Nothing to preview yet. Save your book or edit one from the Browse tab.
      </div>
    );
  }

  const p = pages[idx] || pages[0];
  const isCover = idx === 0;

  return (
    <BookAudioProvider>
      <div className="reader-root reader-shell rounded-2xl overflow-hidden"
           data-theme="sepia" data-size="md"
           data-section={book.section}
           data-testid="studio-preview"
           style={{ background: "var(--reader-bg)" }}>
        <div className="flex items-center justify-between px-3 sm:px-5 py-2.5 border-b border-white/5">
          <p className="font-display text-[13px] text-parchment/90 truncate"><BookOpen className="inline h-3.5 w-3.5 mr-2" />{book.title}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setIdx((i) => Math.max(0, i - 1))}
                    disabled={idx === 0}
                    className="h-8 px-3 inline-flex items-center gap-1 rounded-full text-[11px] font-bold uppercase tracking-wider hover:bg-white/10 disabled:opacity-30"
                    data-testid="studio-preview-prev">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span className="text-[11px] font-bold text-parchment/70" data-testid="studio-preview-indicator">
              {idx}/{Math.max(0, pages.length - 1)}
            </span>
            <button onClick={() => setIdx((i) => Math.min(pages.length - 1, i + 1))}
                    disabled={idx === pages.length - 1}
                    className="h-8 px-3 inline-flex items-center gap-1 rounded-full text-[11px] font-bold uppercase tracking-wider hover:bg-white/10 disabled:opacity-30"
                    data-testid="studio-preview-next">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="book-stage min-h-[520px] py-6 px-4">
          {isCover ? (
            <BookCover book={book} minutes={book.readingMinutes || 6} onBegin={() => setIdx(1)} />
          ) : (
            <article className="book-page" data-testid="studio-preview-page">
              <header>
                <p className="text-[10px] uppercase tracking-[0.25em] mb-1"
                   style={{ color: "var(--reader-muted)" }}>
                  Chapter {idx} of {pages.length - 1} · {book.section}
                </p>
                <h2>{p.title}</h2>
              </header>
              <ChapterBlocks blocks={p.blocks || []} />
            </article>
          )}
        </div>
      </div>
    </BookAudioProvider>
  );
}
