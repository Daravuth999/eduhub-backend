import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useState, useRef } from 'react'
import { Lock, Headphones, Video, BookOpen } from 'lucide-react'
import NewBadge from './NewBadge.jsx'
import SheetBadge from './SheetBadge.jsx'

/**
 * BookCard — a single book on the library shelf.
 *
 * v7.8 upgrades:
 *   • Cover image is treated as the primary artwork (fills the card, not
 *     just a vague background), with a clean bottom dark-glass band that
 *     holds the title + progress.
 *   • Subtle 3D parallax tilt on hover (mouse-driven). The glossy "shine"
 *     layer tracks the cursor — exact same dopamine trick you see in
 *     Pokémon TCG Pocket / Apple product pages.
 *   • Sheet-driven `badge` renders via the new animated <SheetBadge/>
 *     (shimmer sweep + halo pulse + spring bounce).
 */
export default function BookCard({ item, meta, onClick }) {
  const [burst, setBurst] = useState(false)
  const price = Number(item.price) || 0
  const isPaid = price > 0
  const owned = isPaid && !!item._owned
  const showLock = isPaid && !owned
  const hasImage = !!item.coverImage

  /* ---------- mouse-driven 3D parallax tilt ---------- */
  const cardRef = useRef(null)
  const mx = useMotionValue(0.5)
  const my = useMotionValue(0.5)
  const smx = useSpring(mx, { stiffness: 200, damping: 18 })
  const smy = useSpring(my, { stiffness: 200, damping: 18 })
  const rotateY = useTransform(smx, [0, 1], [-10, 10])
  const rotateX = useTransform(smy, [0, 1], [8, -8])
  const shineX = useTransform(smx, [0, 1], ['20%', '80%'])
  const shineY = useTransform(smy, [0, 1], ['15%', '85%'])

  const handlePointerMove = (e) => {
    const el = cardRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    mx.set((e.clientX - r.left) / r.width)
    my.set((e.clientY - r.top) / r.height)
  }
  const resetTilt = () => {
    mx.set(0.5)
    my.set(0.5)
  }

  const handleActivate = () => {
    setBurst(true)
    setTimeout(() => setBurst(false), 700)
    onClick?.()
  }

  return (
    <motion.button
      ref={cardRef}
      type="button"
      onClick={handleActivate}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetTilt}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleActivate()
        }
      }}
      whileHover={{ y: -8, scale: 1.05 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      style={{
        rotateX,
        rotateY,
        transformPerspective: 900,
        transformStyle: 'preserve-3d',
        background: meta.gradient,
        boxShadow:
          '0 22px 40px -18px rgba(0,0,0,0.8), 0 8px 14px -8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -2px 0 rgba(0,0,0,0.45)',
      }}
      className="foil-border book-card book-card--v78 group relative flex h-[228px] w-[152px] flex-none flex-col justify-end overflow-hidden rounded-[16px] text-left text-parchment shadow-card focus:outline-none"
      data-testid={`book-card-${meta.key}`}
    >
      {/* ── cover artwork layer ─────────────────────────────────────── */}
      {hasImage ? (
        <>
          <CoverImage src={item.coverImage} />
          {/* readable scrim — only over the bottom third */}
          <span
            className="pointer-events-none absolute inset-0"
            aria-hidden
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 48%, rgba(0,0,0,0.55) 72%, rgba(0,0,0,0.88) 100%)',
            }}
          />
        </>
      ) : (
        <div className="absolute right-3 top-3 select-none text-[36px] leading-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)]" style={{ transform: 'translateZ(18px)' }}>
          {item.emoji || meta.emoji}
        </div>
      )}

      {/* Spine on the left edge of the "book" */}
      <span
        className="absolute left-0 top-0 h-full w-[6px]"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.65))',
        }}
      />

      {/* Mouse-following gloss shine (parallax) */}
      <motion.span
        className="book-card__shine pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background: useTransform(
            [shineX, shineY],
            ([x, y]) =>
              `radial-gradient(240px circle at ${x} ${y}, rgba(255,255,255,0.22), rgba(255,255,255,0) 60%)`
          ),
        }}
      />

      {/* Top sheen */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-12 rounded-t-[16px]"
        style={{
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.14), transparent)',
        }}
      />

      {/* ── TOP-LEFT badge stack ─────────────────────────────────────
           Price chip only. The animated NEW pill has moved to the
           bottom-right stack (v7.9.6) so it sits opposite the title
           and never collides with the top-right SheetBadge. */}
      {item.inAppSlug && (
        <div
          className="absolute left-2.5 top-2.5 z-20 flex flex-col items-start gap-1.5"
          style={{ transform: 'translateZ(26px)' }}
        >
          {item.inAppSlug && (
            <div
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{
                background: owned
                  ? 'linear-gradient(135deg, rgba(0,191,165,0.95), rgba(45,106,79,0.95))'
                  : isPaid
                  ? 'linear-gradient(135deg, #FFE19A, #D4A843 60%, #9C7A2C)'
                  : 'linear-gradient(135deg, #B8F3D2, #2D6A4F)',
                color: owned ? '#F4EAD0' : isPaid ? '#1a1420' : '#0d2319',
                boxShadow: owned
                  ? '0 6px 14px rgba(0,191,165,0.45)'
                  : isPaid
                  ? '0 6px 14px rgba(212,168,67,0.45), inset 0 1px 0 rgba(255,255,255,0.5)'
                  : '0 6px 14px rgba(45,106,79,0.45)',
              }}
              data-testid="card-price-badge"
            >
              {owned ? '✓ Owned' : isPaid ? `${item.price} pts` : 'Free'}
            </div>
          )}
        </div>
      )}

      {/* ── TOP-RIGHT — instructor SheetBadge (animated label) ─────── */}
      {item.badge && (
        <div
          className="absolute right-2.5 top-2.5 z-20"
          style={{ transform: 'translateZ(28px)' }}
        >
          <SheetBadge label={item.badge} size="sm" testid="card-sheet-badge" />
        </div>
      )}

      {/* ── BOTTOM-RIGHT — NEW pill + content-type chip (v7.9.6) ─────
           The golden NEW pill moves here so it lives opposite the
           SheetBadge (top-right) and never overlaps it. A tiny
           content-type chip (headphones / video / book) sits beneath
           it — the icon is auto-picked from the book's chapter blocks
           (or overridden by the sheet `contentType` column).
           All three items sit on the cover area ABOVE the title band
           so they never clip the multi-line title. */}
      {(item._isNew || item.inAppSlug) && (
        <div
          className="book-card__inapp absolute right-2.5 z-20 flex flex-col items-end gap-1.5"
          style={{
            bottom: 'calc(var(--band-h, 72px) + 8px)',
            transform: 'translateZ(22px)',
          }}
        >
          {item._isNew && !item.badge && <NewBadge />}
          {item.inAppSlug && (
            <ContentTypeChip type={item._contentType} />
          )}
        </div>
      )}

      {/* ── bottom title + progress band ────────────────────────────── */}
      <div
        className="book-card__band relative z-10 px-3 pb-3 pt-2"
        style={{ transform: 'translateZ(14px)' }}
      >
        <p
          className="font-display text-[15px] leading-tight text-parchment line-clamp-2"
          style={{ textShadow: '0 2px 10px rgba(0,0,0,0.7)' }}
        >
          {item.title}
        </p>
        <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-parchment/70">
          {meta.label}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="grid h-4 w-4 place-items-center rounded-full text-[8px]"
            style={{
              background: 'rgba(0,0,0,0.55)',
              color: meta.accent,
            }}
          >
            ▶
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/50">
            <div
              className="h-full rounded-full"
              style={{
                width: `${typeof item.progress === 'number' ? Math.min(100, item.progress) : 0}%`,
                background: 'linear-gradient(90deg, #D4A843, #00BFA5)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Frosted lock overlay — signals paid + not owned */}
      {showLock && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center z-30" aria-hidden>
          <div
            className="grid place-items-center h-12 w-12 rounded-full"
            style={{
              background: 'rgba(8,6,14,0.6)',
              backdropFilter: 'blur(4px)',
              border: '1px solid rgba(212,168,67,0.55)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.65)',
            }}
          >
            <Lock className="h-5 w-5" style={{ color: '#FFE19A' }} />
          </div>
        </div>
      )}

      {/* Sparkle burst on tap */}
      {burst && (
        <span className="pointer-events-none absolute inset-0 z-30">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full bg-conic"
              style={{
                boxShadow: '0 0 8px #FFD700, 0 0 16px #FFD700',
                animation: `burstOut 0.6s ease-out forwards`,
                transform: `rotate(${i * 60}deg) translateX(0)`,
              }}
            />
          ))}
        </span>
      )}

      <style>{`
        @keyframes burstOut {
          to { transform: rotate(var(--r)) translateX(40px); opacity: 0; }
        }
      `}</style>
    </motion.button>
  )
}

/**
 * CoverImage — resilient book cover with Dropbox / Drive fallback chain.
 *
 * Real-world sheets mix many share-URL shapes. The booksService normalizer
 * rewrites them once, but some Dropbox links still fail (302 → preview
 * page). We retry with alternate query params before giving up and hiding.
 */
function CoverImage({ src }) {
  const chain = buildFallbackChain(src)
  const [idx, setIdx] = useState(0)
  const [hidden, setHidden] = useState(false)
  if (hidden || !chain.length) return null
  return (
    <img
      src={chain[idx]}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="book-card__cover pointer-events-none absolute inset-0 h-full w-full object-cover"
      data-testid="card-cover-image"
      onError={() => {
        if (idx + 1 < chain.length) setIdx(idx + 1)
        else setHidden(true)
      }}
    />
  )
}
/**
 * ContentTypeChip — tiny icon pill that auto-reflects the embedded
 * content of the book (audio / video / text). v7.9.6 addition.
 *
 * The *icon* is chosen from lucide-react (already in the project):
 *   • Headphones → `audio`     (any <audio> or `transcript` block)
 *   • Video      → `video`     (any <video>/`embed` block)
 *   • BookOpen   → `text`      (default — prose/markdown only)
 *
 * Matches the existing `book-card__inapp` aesthetic (gold-tinted glass
 * + 8.5px uppercase label) so it doesn't introduce a new visual style.
 */
function ContentTypeChip({ type }) {
  const variants = {
    audio: { Icon: Headphones, label: 'Audio' },
    video: { Icon: Video,      label: 'Video' },
    text:  { Icon: BookOpen,   label: 'Read'  },
  }
  const v = variants[type] || variants.text
  const { Icon, label } = v
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.18em]"
      style={{
        background: 'rgba(212,168,67,0.28)',
        color: '#FFE8A8',
        border: '1px solid rgba(212,168,67,0.55)',
        backdropFilter: 'blur(4px)',
      }}
      data-testid="card-inapp-badge"
      data-content-type={type || 'text'}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2.4} />
      <span>{label}</span>
    </span>
  )
}



function buildFallbackChain(raw) {
  if (!raw) return []
  const out = [raw]
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (/dropboxusercontent\.com$/.test(host) || /dropbox\.com$/.test(host)) {
      // Variant 1: ?raw=1 (already set by normalizer, safe to re-add)
      const v1 = new URL(raw)
      v1.hostname = 'dl.dropboxusercontent.com'
      v1.searchParams.set('raw', '1')
      v1.searchParams.delete('dl')
      out.push(v1.toString())
      // Variant 2: ?dl=1 (classic direct download)
      const v2 = new URL(raw)
      v2.hostname = 'dl.dropboxusercontent.com'
      v2.searchParams.delete('raw')
      v2.searchParams.set('dl', '1')
      out.push(v2.toString())
    }
    if (/googleusercontent\.com$/.test(host) || /drive\.google\.com$/.test(host)) {
      const m = raw.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
      if (m) {
        out.push(`https://lh3.googleusercontent.com/d/${m[1]}=w800`)
        out.push(`https://drive.google.com/thumbnail?id=${m[1]}&sz=w800`)
        out.push(`https://drive.google.com/uc?export=view&id=${m[1]}`)
      }
    }
  } catch { /* bare string, no URL — leave single-entry chain */ }
  // de-dupe while preserving order
  return Array.from(new Set(out))
}
