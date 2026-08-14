import { motion, AnimatePresence } from "framer-motion";
import { X, List, Check } from "lucide-react";

export default function TocDrawer({ open, onClose, book, pages, pageIndex, onJump }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="toc-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="toc-drawer"
            initial={{ x: -360 }}
            animate={{ x: 0 }}
            exit={{ x: -360 }}
            transition={{ type: "spring", damping: 24, stiffness: 220 }}
            data-testid="reader-toc"
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2 text-parchment">
                <List className="h-4 w-4 text-gold" />
                <span className="text-xs uppercase tracking-[0.2em] text-faded">Table of Contents</span>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/5 text-faded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <h3 className="font-display text-[18px] leading-tight text-parchment mb-1">
              {book?.title}
            </h3>
            <p className="text-[11px] text-faded mb-5">{book?.author}</p>

            <ol className="space-y-1.5">
              {pages.map((p, i) => {
                const active = i === pageIndex;
                const done = i < pageIndex;
                return (
                  <li key={i}>
                    <button
                      onClick={() => onJump(i)}
                      className={`w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 transition-all ${
                        active
                          ? "bg-gold/15 text-parchment border border-gold/35"
                          : "hover:bg-white/5 text-faded border border-transparent"
                      }`}
                      data-testid={`toc-item-${i}`}
                    >
                      <span
                        className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${
                          active
                            ? "bg-gold text-ink"
                            : done
                            ? "bg-emerald-700/50 text-parchment"
                            : "bg-walnut text-faded"
                        }`}
                      >
                        {done ? <Check className="h-3 w-3" /> : i === 0 ? "•" : i}
                      </span>
                      <span className="flex-1 min-w-0 truncate text-[13px] font-medium">
                        {i === 0 ? "Cover" : p.title}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
