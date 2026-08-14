// PublicLibraryShelf.jsx — the guest-facing entry point into a real book.
//
// "Read Before You Sign In": for a guest, this shelf (not a hero card
// describing the platform) is the primary content on Home. It reads the
// same public catalog (getAllBooks(), src/eduhub/pages/library/books/
// booksService.js) the authenticated Library page reads, filtered to books
// with no price — the same field (`price`), already used elsewhere for the
// existing purchase-entitlement check, that genuinely decides whether a
// book requires an account (see guest_content_boundary.py on the backend
// and ReaderPage.jsx's guestLocked branch — this is not a new concept).
// Tapping a cover navigates straight into the real Reader; there is no
// separate "book detail" screen to build (none exists today) and none is
// needed here.
//
// Visual/interaction pattern deliberately mirrors ContinueLearningShelf.jsx
// (horizontal snap-scroll shelf, motion.button cards, same stagger/spring
// tokens) rather than inventing a new shelf pattern — the only genuinely
// new thing here is the data source (the public catalog) and the cover
// treatment (real book art, not a section icon).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { BookOpen } from "lucide-react";
import { easing, duration, stagger, spring } from "../../styles/tokens/motionTokens";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { getAllBooks } from "../../pages/library/books/booksService";
import EmptyStateCard from "./EmptyStateCard";

function BookCoverThumb({ book }) {
  const [imgFailed, setImgFailed] = useState(false);
  const hasImage = !!book.coverImage && !imgFailed;
  return (
    <div
      className="relative w-full aspect-[3/4] rounded-xl overflow-hidden flex items-center justify-center"
      style={{ background: book.coverGradient || "linear-gradient(155deg,#8B5CF6,#6D28D9)" }}
    >
      {hasImage ? (
        <img
          src={book.coverImage}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span className="text-3xl" aria-hidden>{book.coverEmoji || "📖"}</span>
      )}
    </div>
  );
}

export default function PublicLibraryShelf() {
  const navigate = useNavigate();
  const [books, setBooks] = useState(null); // null = loading

  useEffect(() => {
    let alive = true;
    getAllBooks({ isAuthenticated: false }) // guest-only component — see file header
      .then((all) => {
        if (!alive) return;
        const free = (all || []).filter((b) => Number(b?.price || 0) <= 0 && b?.slug);
        setBooks(free);
      })
      .catch(() => {
        if (alive) setBooks([]);
      });
    return () => { alive = false; };
  }, []);

  if (books === null) return null; // loading — no skeleton, keeps arrival calm

  if (books.length === 0) {
    return (
      <section data-testid="public-library-shelf">
        <div className="px-4 mb-2.5">
          <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Start Reading</h2>
        </div>
        <div className="px-4">
          <EmptyStateCard
            Icon={BookOpen}
            accent="#8B5CF6"
            title="The Library is getting ready"
            subtitle="Check back soon for a book you can read right away."
            ctaLabel="Browse the Library"
            ctaHref="/library"
            compact
            data-testid="public-library-shelf-empty"
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid="public-library-shelf">
      <div className="px-4 mb-2.5">
        <h2 className="font-display text-[1rem] font-bold text-ink dark:text-white">Start Reading</h2>
        <p className="text-[0.78rem] text-zinc-500 dark:text-white/50 mt-0.5">
          Tap a book — no account needed
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 -mx-0 pb-1 snap-x snap-proximity">
        {books.slice(0, 12).map((b, i) => (
          <motion.button
            key={b.slug}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: duration.base, delay: i * stagger.tight, ease: easing.premiumEaseOut }}
            whileTap={{ scale: 0.97, transition: spring.tap }}
            whileHover={{ y: -2 }}
            onClick={() => navigate(`/library/read/${b.slug}`)}
            className="snap-start flex-none w-[128px] text-left rounded-2xl p-2 bg-white dark:bg-white/[0.05] border border-zinc-200 dark:border-white/[0.08]"
            style={{ borderRadius: radius.lg, boxShadow: elevation.soft }}
            data-testid={`public-library-shelf-card-${i}`}
          >
            <BookCoverThumb book={b} />
            <p className="mt-1.5 text-[0.78rem] font-bold text-ink dark:text-white leading-tight line-clamp-2">
              {b.title}
            </p>
            {b.level && (
              <p className="text-[0.65rem] text-zinc-400 dark:text-white/35 mt-0.5">{b.level}</p>
            )}
          </motion.button>
        ))}
      </div>
    </section>
  );
}
