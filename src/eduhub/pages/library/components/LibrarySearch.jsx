import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, Sparkles, BookOpen } from "lucide-react";

/**
 * LibrarySearch — the sticky, animated search-pill that lives at the
 * top of the /library page. Filters books across every shelf in real
 * time by title / subtitle / author / badge / level / section.
 *
 * Props:
 *   • query        — current search string (controlled).
 *   • onChange     — setter for the parent.
 *   • totalCount   — total number of books before filtering.
 *   • matchCount   — number of books currently matching `query`.
 *   • onPickBook   — called when the user clicks one of the live
 *                    suggestion rows in the dropdown.
 *   • suggestions  — top N matched books, each shaped like:
 *                    { title, subtitle, author, section, badge,
 *                      coverImage, coverEmoji, _book } (≤6).
 */
export default function LibrarySearch({
  query,
  onChange,
  totalCount = 0,
  matchCount = 0,
  onPickBook,
  suggestions = [],
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const wrapperRef = useRef(null);
  const hasQuery = !!query.trim();

  // Esc clears query / blurs.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (hasQuery) onChange("");
        inputRef.current?.blur();
      }
      // Cmd/Ctrl-K → focus input. Power-user flourish.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasQuery, onChange]);

  // Click-outside closes the suggestion dropdown.
  useEffect(() => {
    const onDown = (e) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target)) setFocused(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const showDropdown = focused && hasQuery && suggestions.length > 0;

  return (
    <div
      ref={wrapperRef}
      className="library-search relative z-30"
      data-testid="library-search"
    >
      <motion.div
        layout
        whileHover={{ y: -1 }}
        animate={{
          boxShadow: focused
            ? "0 16px 36px rgba(212,168,67,0.22), 0 0 0 1.5px rgba(212,168,67,0.55), inset 0 1px 0 rgba(255,255,255,0.06)"
            : "0 10px 24px rgba(0,0,0,0.35), 0 0 0 1px rgba(212,168,67,0.22), inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
        transition={{ type: "spring", damping: 22, stiffness: 240 }}
        className="library-search__pill flex items-center gap-3 rounded-full px-4 py-3"
        style={{
          background:
            "linear-gradient(135deg, rgba(45,31,62,0.85), rgba(26,20,32,0.92))",
          backdropFilter: "blur(14px) saturate(140%)",
          WebkitBackdropFilter: "blur(14px) saturate(140%)",
        }}
      >
        <motion.span
          animate={focused ? { rotate: [0, -8, 8, 0] } : { rotate: 0 }}
          transition={{ duration: 0.6 }}
          className="grid h-7 w-7 flex-none place-items-center rounded-full"
          style={{
            background:
              "linear-gradient(135deg, rgba(212,168,67,0.25), rgba(212,168,67,0.08))",
            color: "#FFE19A",
            border: "1px solid rgba(212,168,67,0.45)",
          }}
        >
          <Search className="h-3.5 w-3.5" />
        </motion.span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder="Search books, authors, badges…   ⌘K"
          className="library-search__input flex-1 min-w-0 bg-transparent text-[14px] text-parchment placeholder:text-[rgba(244,229,193,0.45)] outline-none"
          style={{ caretColor: "#D4A843" }}
          data-testid="library-search-input"
          aria-label="Search the library"
        />
        <AnimatePresence initial={false}>
          {hasQuery && (
            <motion.span
              key="results-count"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              className="hidden sm:inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em]"
              style={{
                background: "rgba(212,168,67,0.16)",
                color: "#FFE19A",
                border: "1px solid rgba(212,168,67,0.4)",
              }}
              data-testid="library-search-count"
            >
              <Sparkles className="h-3 w-3" />
              {matchCount} / {totalCount}
            </motion.span>
          )}
          {hasQuery && (
            <motion.button
              key="clear"
              type="button"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
              className="grid h-7 w-7 flex-none place-items-center rounded-full text-parchment/70 hover:text-parchment hover:bg-white/10"
              style={{ border: "1px solid rgba(255,255,255,0.08)" }}
              aria-label="Clear search"
              data-testid="library-search-clear"
            >
              <X className="h-3.5 w-3.5" />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Live suggestion dropdown */}
      <AnimatePresence>
        {showDropdown && (
          <motion.div
            key="suggestions"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="library-search__dropdown absolute left-0 right-0 mt-2 overflow-hidden rounded-2xl"
            style={{
              background:
                "linear-gradient(160deg, rgba(45,31,62,0.96), rgba(20,14,28,0.96))",
              backdropFilter: "blur(18px) saturate(150%)",
              WebkitBackdropFilter: "blur(18px) saturate(150%)",
              border: "1px solid rgba(212,168,67,0.28)",
              boxShadow:
                "0 30px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
            data-testid="library-search-suggestions"
          >
            <div className="px-4 py-2 text-[10px] uppercase tracking-[0.22em] text-parchment/55">
              Top matches
            </div>
            <ul className="max-h-[320px] overflow-y-auto pb-2">
              {suggestions.map((s, i) => (
                <motion.li
                  key={(s._book?.slug || s.title) + i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setFocused(false);
                      onPickBook?.(s);
                    }}
                    className="library-search__row group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5 focus:outline-none focus:bg-white/8"
                    data-testid={`library-search-suggest-${i}`}
                  >
                    <span
                      className="grid h-10 w-10 flex-none place-items-center rounded-md text-[18px] overflow-hidden relative"
                      style={{
                        background:
                          "linear-gradient(135deg, rgba(212,168,67,0.25), rgba(74,58,106,0.4))",
                        border: "1px solid rgba(255,255,255,0.08)",
                        boxShadow: "0 6px 12px -6px rgba(0,0,0,0.5)",
                      }}
                      aria-hidden
                    >
                      {isSafeHttpsUrl(s.coverImage) ? (
                        <img
                          src={s.coverImage}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        s.coverEmoji || "📖"
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate font-display text-[14px] text-parchment"
                        dangerouslySetInnerHTML={{
                          __html: highlightMatch(s.title, query),
                        }}
                      />
                      <p className="truncate text-[11px] text-parchment/60">
                        <span className="uppercase tracking-[0.18em]">
                          {s.section || "story"}
                        </span>
                        {s.author ? ` · ${s.author}` : ""}
                        {s.subtitle ? ` · ${s.subtitle}` : ""}
                      </p>
                    </div>
                    {s.badge && (
                      <span
                        className="hidden sm:inline-flex flex-none items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em]"
                        style={{
                          background:
                            "linear-gradient(135deg, #FFB3D1, #E63976)",
                          color: "#1a0a14",
                        }}
                      >
                        {s.badge}
                      </span>
                    )}
                    <BookOpen
                      className="h-4 w-4 flex-none text-parchment/30 transition-colors group-hover:text-gold"
                    />
                  </button>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state under the pill when query matches nothing */}
      <AnimatePresence>
        {focused && hasQuery && suggestions.length === 0 && (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="library-search__empty absolute left-0 right-0 mt-2 rounded-2xl px-5 py-4 text-center"
            style={{
              background:
                "linear-gradient(160deg, rgba(45,31,62,0.92), rgba(20,14,28,0.92))",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              border: "1px solid rgba(255,255,255,0.06)",
              color: "rgba(244, 229, 193, 0.7)",
            }}
            data-testid="library-search-empty"
          >
            <p className="text-[13px]">
              No books match{" "}
              <span className="text-gold font-semibold">“{query}”</span>
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-parchment/45">
              Try a different word, author or badge
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ----------------------- helpers ----------------------- */

function highlightMatch(text, q) {
  const safe = String(text || "");
  const needle = String(q || "").trim();
  if (!needle) return escape(safe);
  const re = new RegExp(`(${escapeRegExp(needle)})`, "ig");
  return escape(safe).replace(
    re,
    '<mark style="background:rgba(255,225,154,0.32);color:#FFE19A;border-radius:3px;padding:0 2px;">$1</mark>'
  );
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * v7.9.8 — safe-URL gate for cover images rendered from sheet-driven
 * content. Accepts only http(s) URLs; rejects `javascript:`, `data:`,
 * `file:`, embedded quotes, whitespace, and anything that could break
 * out of an inline CSS `url("…")`. Everything else falls back to the
 * emoji/gradient placeholder.
 */
function isSafeHttpsUrl(raw) {
  if (!raw || typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s) return false;
  if (/["'\\\s<>]/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
