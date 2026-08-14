// LibraryShowcase.jsx — top-priority dashboard hero featuring a 3D animated
//   book scene that teases the Classroom Library and pushes guests to sign in.
//   Replaces the previous shelf-style LibraryHero with a higher-energy
//   parallax/3D presentation. Mobile-friendly: gracefully scales on small widths.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BookOpen,
  Sparkles,
  ArrowRight,
  Lock,
  GraduationCap,
  Library as LibraryIcon,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";

/* ───────────────────────────  3D BOOK PRIMITIVE  ────────────────────────── */

const BOOKS = [
  {
    key: "story",
    title: "Stories",
    khmer: "រឿង",
    glyph: "📖",
    contentField: "story",
    palette: {
      front: "linear-gradient(155deg, #6A2D2D 0%, #3A1B1B 100%)",
      spine: "linear-gradient(180deg, #4A1F1F 0%, #2A0F0F 100%)",
      glow: "rgba(233, 122, 122, 0.55)",
      accent: "#E97A7A",
    },
  },
  {
    key: "conversation",
    title: "Conversations",
    khmer: "ការសន្ទនា",
    glyph: "🗣️",
    contentField: "conversation",
    palette: {
      front: "linear-gradient(155deg, #6A4A2D 0%, #3A2A1B 100%)",
      spine: "linear-gradient(180deg, #4A3220 0%, #261810 100%)",
      glow: "rgba(232, 179, 119, 0.6)",
      accent: "#E8B377",
    },
  },
  {
    key: "exercise",
    title: "Exercises",
    khmer: "លំហាត់",
    glyph: "🧠",
    contentField: "exercise",
    palette: {
      front: "linear-gradient(155deg, #2E4A7A 0%, #1B2A4A 100%)",
      spine: "linear-gradient(180deg, #1F345A 0%, #0F1A36 100%)",
      glow: "rgba(125, 168, 224, 0.55)",
      accent: "#7DA8E0",
    },
  },
];

const Book3D = memo(function Book3D({ book, index, count, hovered, onHover, parallax }) {
  // Spread books across a 3-up arc; centre book sits forward.
  const spread = (index - (count - 1) / 2) * 86; // px on x
  const tilt = (index - (count - 1) / 2) * 8;     // deg of base Y rotation
  const baseZ = -Math.abs(index - (count - 1) / 2) * 30;

  // When another book is hovered, push neighbours apart slightly.
  const isHovered = hovered === index;
  const hoverShift = hovered == null ? 0 : (index - hovered) * 18;

  return (
    <motion.button
      type="button"
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(index)}
      onBlur={() => onHover(null)}
      data-testid={`library-3d-book-${book.key}`}
      style={{
        transformStyle: "preserve-3d",
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 104,
        height: 146,
        marginLeft: -52,
        marginTop: -73,
        transformOrigin: "center center",
        cursor: "pointer",
        outline: "none",
        WebkitTapHighlightColor: "transparent",
      }}
      animate={{
        x: spread + hoverShift + parallax.x * (1 - Math.abs(index - 1) * 0.4),
        y:
          (isHovered ? -22 : 0) +
          parallax.y * (1 - Math.abs(index - 1) * 0.4),
        z: isHovered ? 80 : baseZ,
        rotateY: (isHovered ? 0 : tilt) + parallax.rx * 0.6,
        rotateX: parallax.ry * -0.4,
        scale: isHovered ? 1.08 : 1,
      }}
      transition={{
        type: "spring",
        stiffness: 180,
        damping: 22,
        mass: 0.7,
      }}
      whileTap={{ scale: 1.04, rotateY: 0 }}
    >
      {/* Idle bob — independent loop */}
      <motion.div
        style={{ transformStyle: "preserve-3d", width: "100%", height: "100%" }}
        animate={{ y: [0, -6, 0] }}
        transition={{
          duration: 4 + index * 0.6,
          ease: "easeInOut",
          repeat: Infinity,
          delay: index * 0.4,
        }}
      >
        {/* Pulsing aura */}
        <motion.div
          aria-hidden
          style={{
            position: "absolute",
            inset: -32,
            borderRadius: 24,
            background: `radial-gradient(closest-side, ${book.palette.glow}, transparent 70%)`,
            filter: "blur(20px)",
            transform: "translateZ(-40px)",
            opacity: isHovered ? 0.95 : 0.55,
          }}
          animate={{ opacity: isHovered ? [0.7, 1, 0.7] : [0.45, 0.65, 0.45] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Front cover */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background: book.palette.front,
            transform: "translateZ(7px)",
            boxShadow:
              "0 22px 38px -16px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -2px 0 rgba(0,0,0,0.4)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            padding: 12,
          }}
        >
          {/* Top sheen */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.10), transparent 50%)",
              pointerEvents: "none",
            }}
          />
          {/* Foil ornament */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 8,
              border: `1px solid ${book.palette.accent}40`,
              borderRadius: 4,
              pointerEvents: "none",
            }}
          />
          {/* Glyph */}
          <span
            style={{
              fontSize: 28,
              lineHeight: 1,
              filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.5))",
              alignSelf: "flex-end",
            }}
            aria-hidden
          >
            {book.glyph}
          </span>
          {/* Title */}
          <div style={{ marginTop: "auto", position: "relative" }}>
            <p
              className="font-display"
              style={{
                fontSize: 12,
                lineHeight: 1.15,
                color: "#F0E6C8",
                textShadow: "0 2px 8px rgba(0,0,0,0.6)",
                letterSpacing: "-0.01em",
                fontWeight: 700,
              }}
            >
              {book.title}
            </p>
            <p
              className="khmer"
              style={{
                fontSize: 9,
                color: book.palette.accent,
                marginTop: 2,
                opacity: 0.9,
              }}
            >
              {book.khmer}
            </p>
            <span
              aria-hidden
              style={{
                display: "block",
                marginTop: 8,
                height: 2,
                width: 32,
                background: `linear-gradient(90deg, ${book.palette.accent}, transparent)`,
                borderRadius: 999,
              }}
            />
          </div>
        </div>

        {/* Spine (left side, depth) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 14,
            height: "100%",
            background: book.palette.spine,
            transform: "rotateY(-90deg) translateZ(0)",
            transformOrigin: "left center",
            boxShadow: "inset -1px 0 0 rgba(0,0,0,0.6)",
          }}
        />

        {/* Back cover */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background: book.palette.spine,
            transform: "translateZ(-7px) rotateY(180deg)",
          }}
        />

        {/* Pages (top edge texture) */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: -2,
            left: 4,
            right: 4,
            height: 6,
            background:
              "repeating-linear-gradient(90deg, #f0e6c8 0 1px, #d6cba6 1px 2px)",
            transform: "translateZ(0) rotateX(60deg)",
            transformOrigin: "top center",
            opacity: 0.85,
          }}
        />

        {/* Specular highlight glide on hover */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background:
              "linear-gradient(110deg, transparent 35%, rgba(255,255,255,0.45) 50%, transparent 65%)",
            transform: `translateZ(8px) translateX(${isHovered ? "60%" : "-130%"})`,
            transition: "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
            mixBlendMode: "overlay",
            pointerEvents: "none",
            opacity: 0.75,
          }}
        />
      </motion.div>
    </motion.button>
  );
});

/* ───────────────────────────  GOLD DUST PARTICLES  ───────────────────────── */

function GoldDust({ count = 18 }) {
  const particles = useMemo(
    () =>
      Array.from({ length: count }).map(() => ({
        left: Math.random() * 100,
        size: 1 + Math.random() * 2.5,
        delay: Math.random() * 8,
        duration: 9 + Math.random() * 8,
        opacity: 0.35 + Math.random() * 0.45,
      })),
    [count],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {particles.map((d, i) => (
        <span
          key={i}
          className="absolute bottom-[-10%] rounded-full animate-dustFloat"
          style={{
            left: `${d.left}%`,
            width: d.size,
            height: d.size,
            background: "#D4A843",
            animationDuration: `${d.duration}s`,
            animationDelay: `${d.delay}s`,
            opacity: d.opacity,
            boxShadow: "0 0 6px #D4A843, 0 0 12px rgba(212,168,67,0.6)",
          }}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────  COUNTS PILL  ─────────────────────────────── */

function CountPill({ icon, label, value, accent }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider"
      style={{
        background: `${accent}1A`,
        border: `1px solid ${accent}55`,
        color: accent,
      }}
    >
      {icon}
      <span className="tnum text-white">{value}</span>
      <span className="opacity-80 uppercase">{label}</span>
    </span>
  );
}

/* ─────────────────────────────  MAIN COMPONENT  ──────────────────────────── */

export default function LibraryShowcase() {
  const { isAuthenticated } = useAuth();
  const [hovered, setHovered] = useState(null);
  const [parallax, setParallax] = useState({ x: 0, y: 0, rx: 0, ry: 0 });
  const [counts, setCounts] = useState(null);
  const sceneRef = useRef(null);

  // Pull live counts from the sheet-driven catalog so the numbers here
  // always match what actually shows on the shelves. Previously we
  // pulled from `getContent()` (legacy GAS feed), which could include
  // redirect-only items that v7.9.1+ filter out of the shelves — the
  // count and the rendered books then disagreed (v7.9.8 C1 fix).
  useEffect(() => {
    let cancelled = false;
    import("../pages/library/books/booksService")
      .then((m) => m.getAllBooks())
      .then((books) => {
        if (cancelled || !Array.isArray(books)) return;
        setCounts({
          story: books.filter((b) => b.section === "story").length,
          conversation: books.filter((b) => b.section === "conversation").length,
          exercise: books.filter((b) => b.section === "exercise").length,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Mouse parallax over the scene
  function onMouseMove(e) {
    const el = sceneRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width - 0.5;
    const cy = (e.clientY - rect.top) / rect.height - 0.5;
    setParallax({
      x: cx * 18,
      y: cy * 12,
      rx: cx * 14,
      ry: cy * 12,
    });
  }
  function onMouseLeave() {
    setParallax({ x: 0, y: 0, rx: 0, ry: 0 });
    setHovered(null);
  }

  return (
    <section
      className="relative -mx-3 sm:-mx-5 mb-5 sm:mb-6 px-3 sm:px-6 pt-5 pb-5 rounded-3xl overflow-hidden"
      data-testid="library-showcase"
      style={{
        background:
          "radial-gradient(ellipse at 18% -10%, rgba(93,61,30,0.55), transparent 55%), " +
          "radial-gradient(ellipse at 82% 110%, rgba(45,106,79,0.32), transparent 55%), " +
          "linear-gradient(180deg, #110b1a 0%, #0a0712 100%)",
        boxShadow:
          "0 28px 70px -28px rgba(0,0,0,0.7), inset 0 1px 0 rgba(212,168,67,0.22)",
        border: "1px solid rgba(212,168,67,0.28)",
      }}
    >
      {/* Animated gradient ribbon at the top */}
      <motion.div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #FFE19A, #D4A843, #2D6A4F, #FFE19A, transparent)",
          backgroundSize: "200% 100%",
        }}
        animate={{ backgroundPositionX: ["0%", "200%"] }}
        transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
      />

      <GoldDust count={20} />

      <div className="relative grid gap-6 lg:grid-cols-12 items-center">
        {/* Left: copy + CTA */}
        <div className="lg:col-span-5 relative z-10">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.22em]"
              style={{
                color: "#FFE19A",
                background:
                  "linear-gradient(90deg, rgba(212,168,67,0.22), rgba(45,106,79,0.22))",
                border: "1px solid rgba(212,168,67,0.45)",
              }}
            >
              <Sparkles className="h-2.5 w-2.5" /> First Priority
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faded">
              Live · Auth-required
            </span>
          </div>

          <motion.h2
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="font-display text-3xl sm:text-4xl leading-[1.05] tracking-tight"
            style={{
              backgroundImage:
                "linear-gradient(120deg, #F0E6C8 18%, #FFE9A8 40%, #D4A843 65%, #F0E6C8 95%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundSize: "200% 100%",
              animation: "iridescent 7s linear infinite",
            }}
            data-testid="library-showcase-title"
          >
            Classroom Library
          </motion.h2>

          <p
            className="khmer text-[12px] mt-1.5"
            style={{ color: "#D4A84399" }}
            lang="km"
          >
            បណ្ណាល័យឯកជនរបស់អ្នក
          </p>

          <p className="mt-3 text-sm leading-relaxed text-parchment/80 max-w-[440px]">
            A private, gamified reading sanctuary. Build streaks, earn gems, and level
            up by completing real lessons. Sign in with your Student ID to step inside.
          </p>

          {/* Live counts */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            <CountPill
              icon={<BookOpen className="h-3 w-3" />}
              label="Stories"
              value={counts?.story ?? "—"}
              accent="#E97A7A"
            />
            <CountPill
              icon={<Sparkles className="h-3 w-3" />}
              label="Conversations"
              value={counts?.conversation ?? "—"}
              accent="#E8B377"
            />
            <CountPill
              icon={<GraduationCap className="h-3 w-3" />}
              label="Exercises"
              value={counts?.exercise ?? "—"}
              accent="#7DA8E0"
            />
          </div>

          {/* CTA */}
          <div className="mt-5 flex items-center gap-2.5 flex-wrap">
            <motion.div
              whileHover={{ y: -2, scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
            >
              <Link
                to={isAuthenticated ? "/library" : "/login?redirect=/library"}
                data-testid="library-showcase-cta"
                className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-ink"
                style={{
                  background:
                    "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                  boxShadow:
                    "0 14px 32px rgba(212,168,67,0.45), inset 0 1px 0 rgba(255,255,255,0.6)",
                }}
              >
                <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/55 to-transparent transition-transform duration-[1100ms] group-hover:translate-x-full" />
                {isAuthenticated ? (
                  <>
                    <LibraryIcon className="h-4 w-4" />
                    Open Library
                  </>
                ) : (
                  <>
                    <Lock className="h-4 w-4" />
                    Sign in to access
                  </>
                )}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </motion.div>

            <span className="text-[10px] uppercase tracking-[0.22em] text-faded">
              Backend-verified login
            </span>
          </div>
        </div>

        {/* Right: 3D scene */}
        <div className="lg:col-span-7 relative">
          <div
            ref={sceneRef}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            className="relative mx-auto h-[210px] sm:h-[240px] w-full max-w-[520px]"
            style={{ perspective: 1100 }}
            aria-label="Animated preview of library categories"
          >
            {/* Ground glow */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-6 h-12 w-[70%] rounded-full"
              style={{
                background:
                  "radial-gradient(closest-side, rgba(212,168,67,0.45), transparent 70%)",
                filter: "blur(20px)",
              }}
            />
            {BOOKS.map((b, i) => (
              <Book3D
                key={b.key}
                book={b}
                index={i}
                count={BOOKS.length}
                hovered={hovered}
                onHover={setHovered}
                parallax={parallax}
              />
            ))}

            {/* Floating sparkle accents */}
            <motion.span
              aria-hidden
              className="absolute left-[8%] top-[14%] text-[#FFE19A]"
              animate={{ y: [0, -8, 0], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <Sparkles className="h-4 w-4 drop-shadow-[0_0_10px_rgba(212,168,67,0.8)]" />
            </motion.span>
            <motion.span
              aria-hidden
              className="absolute right-[6%] top-[40%] text-[#FFE19A]"
              animate={{ y: [0, -6, 0], opacity: [0.4, 0.95, 0.4] }}
              transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut", delay: 0.8 }}
            >
              <Sparkles className="h-3 w-3 drop-shadow-[0_0_8px_rgba(212,168,67,0.7)]" />
            </motion.span>
            <motion.span
              aria-hidden
              className="absolute left-[40%] bottom-[6%] text-[#FFE19A]"
              animate={{ y: [0, -5, 0], opacity: [0.45, 0.9, 0.45] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut", delay: 1.6 }}
            >
              <Sparkles className="h-3 w-3 drop-shadow-[0_0_8px_rgba(212,168,67,0.7)]" />
            </motion.span>
          </div>
        </div>
      </div>
    </section>
  );
}
