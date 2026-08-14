// LibraryHero.jsx — top-priority dashboard section showcasing the Classroom
//   Library bookshelves. Renders inline on / so users see Stories,
//   Conversations and Exercises before anything else.
import { memo, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { BookOpen, ArrowRight, Sparkles, Lock } from "lucide-react";
import { getContent } from "../pages/library/api";
import { SECTION_ORDER, SECTION_META, isItemNew } from "../pages/library/sections";
import Bookshelf from "../pages/library/components/Bookshelf.jsx";
import ConfirmModal from "../pages/library/components/ConfirmModal.jsx";
import { useAuth } from "../context/AuthContext";
import "../pages/library/library-theme.css";

const LibraryHero = memo(function LibraryHero() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [content, setContent] = useState(null);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getContent()
      .then((d) => {
        if (cancelled) return;
        setContent(d?.success && d.content ? d.content : { story: [], conversation: [], exercise: [] });
      })
      .catch(() => !cancelled && setContent({ story: [], conversation: [], exercise: [] }));
    return () => { cancelled = true; };
  }, []);

  return (
    <section
      className="relative -mx-3 sm:-mx-5 mb-6 sm:mb-8 px-3 sm:px-5 pt-5 pb-6 rounded-3xl overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 12% -10%, rgba(93,61,30,0.45), transparent 55%), radial-gradient(ellipse at 88% 110%, rgba(45,106,79,0.30), transparent 55%), linear-gradient(180deg, #110b1a 0%, #0a0712 100%)",
        boxShadow: "0 24px 60px -24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(212,168,67,0.18)",
        border: "1px solid rgba(212,168,67,0.22)",
      }}
      data-testid="library-hero"
    >
      {/* Header */}
      <div className="relative flex items-center gap-3 mb-4">
        <motion.div
          initial={{ scale: 0.85, rotate: -6, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", damping: 18, stiffness: 220 }}
          className="grid h-12 w-12 place-items-center rounded-2xl text-ink shrink-0"
          style={{
            background: "linear-gradient(135deg, #FFE19A, #D4A843 60%, #9C7A2C)",
            boxShadow: "0 10px 24px rgba(212,168,67,0.4)",
          }}
        >
          <BookOpen className="h-5 w-5" strokeWidth={2.4} />
        </motion.div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.2em]"
              style={{
                color: "#FFE19A",
                background: "linear-gradient(90deg, rgba(212,168,67,0.22), rgba(45,106,79,0.22))",
                border: "1px solid rgba(212,168,67,0.4)",
              }}
            >
              <Sparkles className="h-2.5 w-2.5" /> Featured
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faded">
              Top priority
            </span>
          </div>
          <h2
            className="font-display text-xl sm:text-2xl leading-tight tracking-tight"
            style={{
              backgroundImage:
                "linear-gradient(120deg, #F0E6C8 18%, #FFE9A8 45%, #D4A843 70%, #F0E6C8 95%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundSize: "200% 100%",
            }}
            data-testid="library-hero-title"
          >
            Classroom Library
          </h2>
          <p className="khmer text-[11px] text-faded mt-0.5">
            រឿង · ការសន្ទនា · លំហាត់
          </p>
        </div>
        <Link
          to="/library"
          data-testid="library-hero-open"
          className="hidden sm:inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider text-ink shadow-[0_10px_24px_rgba(212,168,67,0.45)] hover:translate-y-[-2px] transition-transform"
          style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
        >
          Open Library <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Mobile open button */}
      <Link
        to="/library"
        className="sm:hidden mb-3 inline-flex items-center justify-center gap-1.5 w-full rounded-full px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-ink shadow-[0_10px_24px_rgba(212,168,67,0.45)]"
        style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
      >
        Open Full Library <ArrowRight className="h-3.5 w-3.5" />
      </Link>

      {/* Shelves */}
      <div className="relative space-y-5">
        {!content && (
          <div className="space-y-5">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <div className="mb-2 h-4 w-32 rounded bg-walnut/80 animate-pulse" />
                <div className="flex gap-3">
                  {[0, 1, 2, 3].map((j) => (
                    <div key={j} className="h-[224px] w-[148px] flex-none rounded-2xl bg-walnut/70 animate-pulse" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {content &&
          SECTION_ORDER.map((key) => {
            const meta = SECTION_META[key];
            const items = (content[key] || []).map((it) => ({ ...it, _isNew: isItemNew(it) }));
            return (
              <Bookshelf
                key={key}
                meta={meta}
                items={items}
                onCardClick={(item) =>
                  item.link?.trim()
                    ? setPending({ item, sectionKey: key, meta })
                    : null
                }
              />
            );
          })}
      </div>

      {!isAuthenticated && (
        <p className="relative mt-4 text-center text-[11px] text-faded inline-flex items-center justify-center gap-1.5 w-full">
          <Lock className="h-3 w-3 text-gold" />
          Sign in to start lessons and earn points
        </p>
      )}

      {pending && (
        <ConfirmModal
          item={pending.item}
          meta={pending.meta}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            // Defer to /library so the full lesson flow (toast, stats refresh,
            // restriction overlay) lives in one place. Auth-gating happens there.
            navigate(isAuthenticated ? "/library" : "/login?redirect=/library");
            // Open lesson immediately so the user gets the link they tapped.
            if (p.item.link) {
              let url = p.item.link.trim();
              if (!/^https?:\/\//i.test(url)) url = "https://" + url;
              window.open(url, "_blank", "noopener,noreferrer");
            }
          }}
        />
      )}
    </section>
  );
});

export default LibraryHero;
