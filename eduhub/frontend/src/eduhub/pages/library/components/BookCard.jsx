import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useMemo, useRef, useState } from 'react'
import { Lock, Headphones, Video, BookOpen } from 'lucide-react'
import NewBadge from './NewBadge.jsx'
import SheetBadge from './SheetBadge.jsx'
import StylizedCover from '../reader/StylizedCover.jsx'

/**
 * v9.2 — Library tier classification visual map.
 *
 *   free      → no ribbon (price chip already says "Free")
 *   standard  → calm slate pill        (subtle, low-noise)
 *   premium   → golden aurora pill     (matches the price chip)
 *   limited   → platinum/holographic + faint pulse
 *
 * The ribbon is intentionally smaller than the price chip and is
 * STACKED UNDER THE PRICE CHIP (top-left column) so the top-right
 * column is reserved for the instructor's free-form SheetBadge and
 * never collides with it. We also auto-suppress the ribbon when the
 * instructor's SheetBadge text already mentions the same tier word
 * (e.g. badge="STANDARD" cancels the auto "STANDARD" ribbon — no
 * more double-stamping).
 */
const TIER_META = {
  free: {
    label: 'Free',
    background: 'linear-gradient(135deg, rgba(184,243,210,0.95), rgba(45,106,79,0.95))',
    color: '#062018',
    border: 'rgba(184,243,210,0.55)',
    shadow: '0 4px 10px rgba(0,191,165,0.30)',
  },
  standard: {
    label: 'Standard',
    background: 'linear-gradient(135deg, rgba(232,241,255,0.92), rgba(125,168,224,0.85))',
    color: '#0a1426',
    border: 'rgba(232,241,255,0.55)',
    shadow: '0 4px 10px rgba(125,168,224,0.30)',
  },
  premium: {
    label: 'Premium',
    background: 'linear-gradient(135deg, #FFE19A 0%, #D4A843 60%, #9C7A2C 100%)',
    color: '#1a1208',
    border: 'rgba(255,225,154,0.75)',
    shadow: '0 6px 14px rgba(212,168,67,0.40), inset 0 1px 0 rgba(255,255,255,0.55)',
  },
  limited: {
    label: 'Limited',
    background: 'linear-gradient(135deg, #F5E0FF 0%, #B98EFF 45%, #6E48FF 100%)',
    color: '#FFFFFF',
    border: 'rgba(245,224,255,0.78)',
    shadow: '0 6px 16px rgba(110,72,255,0.50), inset 0 1px 0 rgba(255,255,255,0.45)',
  },
}

// Marketing tags that may render as a small secondary chip (top-right).
// Tier words below are intentionally absent — they collapse into the edition ribbon.
const SECONDARY_BADGE_RE = /^(NEW|HOT|BESTSELLER|FEATURED|CLASS\s+FAVORITE|A[12]|B[12]|C[12])$/i

function tierFromBadgeText(raw) {
  const u = String(raw || '').toUpperCase().trim()
  if (!u) return null
  if (/\b(LIMITED\s+EDITION|LIMITED|LE|EXCLUSIVE)\b/.test(u)) return 'limited'
  if (/\bPREMIUM\b/.test(u)) return 'premium'
  if (/\bSTANDARD\b/.test(u)) return 'standard'
  if (/\bFREE\b/.test(u)) return 'free'
  return null
}

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
 *
 * v8.2 — Cover-image flicker fix:
 *   The original `CoverImage` always restarted its Dropbox/Drive
 *   fallback chain at index 0 on every mount, so cards that survived a
 *   list reorder (or whose key changed for any reason) briefly flashed
 *   the StylizedCover before the real image finished loading. We now
 *   memoise the chain per `src`, remember the winning URL in a module-
 *   level cache, and on every subsequent mount we go straight to the
 *   variant that worked last time. Combined with the stable key in
 *   Bookshelf.jsx, the flicker is gone — but every existing prop,
 *   data-testid, fallback branch and animation behaviour is preserved.
 */
export default function BookCard({ item, meta, onClick }) {
  const [burst, setBurst] = useState(false)
  const price = Number(item.price) || 0
  const isPaid = price > 0
  const owned = isPaid && !!item._owned
  const showLock = isPaid && !owned
  const hasImage = !!item.coverImage
  // v9.4 — Library tier classification.
  //
  // The book object is already normalised through normalizeBook() in
  // booksService.js, so `item.tier` is ALWAYS one of
  // {free,standard,premium,limited}. We keep the previous local fallback
  // chain ONLY as a defensive shim for sandbox / preview surfaces that
  // hand us a raw object without going through the normaliser. In that
  // pathological case we default to "free" rather than re-introducing
  // the deprecated price-band coupling.
  // v10.1 polish — single edition ribbon, no double-stamping.
  // Tier can come from the normalised book, OR from a sheet-driven
  // "badge" column whose value is itself a tier word (LIMITED EDITION,
  // PREMIUM, STANDARD, FREE). When the badge IS the tier we collapse it
  // into the edition ribbon and never render it as a second floating chip.
  const badgeRaw = String(item.badge || '').trim()
  const badgeAsTier = tierFromBadgeText(badgeRaw)
  const tier = (
    badgeAsTier ||
    item.tier ||
    item._book?.tier ||
    (isPaid ? 'standard' : 'free')
  ).toLowerCase()
  const tierMeta = TIER_META[tier] || TIER_META.free

  // Only render the top-right marketing chip when the badge is a real
  // marketing tag — NOT a tier word, NOT free-form noise that would
  // visually fight the title on a 152px-wide card.
  const secondaryBadge =
    !badgeAsTier && badgeRaw && SECONDARY_BADGE_RE.test(badgeRaw.toUpperCase())
      ? badgeRaw
      : null


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
      data-tier={tier}
    >
      {/* ── cover artwork layer ─────────────────────────────────────── */}
      {hasImage ? (
        <>
          <CoverImage
            src={item.coverImage}
            fallback={
              <StylizedCover
                title={item.title}
                section={item.section || meta.key}
                gradient={meta.gradient}
                accent={meta.accent}
                emoji={item.emoji || meta.emoji}
                testid="card-cover-stylized"
              />
            }
          />
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
        <StylizedCover
          title={item.title}
          section={item.section || meta.key}
          gradient={meta.gradient}
          accent={meta.accent}
          emoji={item.emoji || meta.emoji}
          testid="card-cover-stylized"
        />
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

      {/* ── TOP-LEFT — single edition ribbon ─────────────────────────
           v10.1 polish: ONE clean tier ribbon only (Free / Standard /
           Premium / Limited). Price/cost no longer lives here — for
           locked paid books it sits inside the centre lock badge so
           the corners stay uncluttered. Owned books get a tiny ✓
           confirmation under the ribbon. */}
      <div
        className="absolute left-2.5 top-2.5 z-20 flex flex-col items-start gap-1"
        style={{ transform: 'translateZ(26px)' }}
        data-testid="card-left-stack"
      >
        <span
          className="inline-flex items-center rounded-full px-2 py-[2px] text-[9.5px] font-extrabold uppercase tracking-[0.18em]"
          style={{
            background: tierMeta.background,
            color: tierMeta.color,
            border: `1px solid ${tierMeta.border}`,
            boxShadow: tierMeta.shadow,
            backdropFilter: 'blur(4px)',
            animation: tier === 'limited' ? 'tierLimitedPulse 2400ms ease-in-out infinite' : undefined,
          }}
          data-testid={`card-tier-${tier}`}
          data-edition={tier}
        >
          {tierMeta.label}
        </span>

        {owned && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[8.5px] font-bold uppercase tracking-[0.18em]"
            style={{
              background: 'linear-gradient(135deg, rgba(0,191,165,0.95), rgba(45,106,79,0.95))',
              color: '#F4EAD0',
              boxShadow: '0 4px 10px rgba(0,191,165,0.35)',
            }}
            data-testid="card-owned-chip"
          >
            ✓ Owned
          </span>
        )}
      </div>

      {/* ── TOP-RIGHT — secondary marketing chip. Rendered only for
           genuine marketing tags (NEW / HOT / BESTSELLER / FEATURED /
           CLASS FAVORITE / level codes). Tier words are absorbed into
           the edition ribbon and never appear here. The .book-card__sheet-badge
           wrapper collapses to icon-only on the narrowest viewports
           (see scoped CSS at the bottom of this file). */}
      {secondaryBadge && (
        <div
          className="book-card__sheet-badge absolute right-2.5 top-2.5 z-20"
          style={{ transform: 'translateZ(28px)' }}
        >
          <SheetBadge label={secondaryBadge} size="sm" testid="card-sheet-badge" />
        </div>
      )}

      {/* ── BOTTOM-RIGHT — content-type chip + NEW pill.
           Sits above the title band so it never clips the title. */}
      {(item._isNew || item.inAppSlug) && (
        <div
          className="book-card__inapp absolute right-2.5 z-20 flex flex-col items-end gap-1.5"
          style={{
            bottom: 'calc(var(--band-h, 72px) + 8px)',
            transform: 'translateZ(22px)',
          }}
        >
          {item._isNew && !secondaryBadge && <NewBadge />}
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

      {/* Frosted lock overlay — signals paid + not owned.
          v10.1 polish: the points cost moves here, beneath the lock,
          so it never fights with the edition ribbon or title. */}
      {showLock && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center z-30" aria-hidden>
          <div className="flex flex-col items-center gap-1.5">
            <div
              className="grid place-items-center h-12 w-12 rounded-full"
              style={{
                background: 'rgba(8,6,14,0.62)',
                backdropFilter: 'blur(4px)',
                border: '1px solid rgba(212,168,67,0.55)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.65)',
              }}
            >
              <Lock className="h-5 w-5" style={{ color: '#FFE19A' }} />
            </div>
            {isPaid && (
              <span
                className="rounded-full px-2 py-[2px] text-[10px] font-extrabold uppercase tracking-[0.16em]"
                style={{
                  background: 'linear-gradient(135deg, #FFE19A, #D4A843 60%, #9C7A2C)',
                  color: '#1a1208',
                  border: '1px solid rgba(255,225,154,0.55)',
                  boxShadow: '0 4px 12px rgba(212,168,67,0.40), inset 0 1px 0 rgba(255,255,255,0.45)',
                }}
                data-testid="card-lock-price"
              >
                {item.price} pts
              </span>
            )}
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
        @keyframes tierLimitedPulse {
          0%, 100% {
            box-shadow: 0 6px 18px rgba(110,72,255,0.55), inset 0 1px 0 rgba(255,255,255,0.45);
            filter: brightness(1);
          }
          50% {
            box-shadow: 0 8px 28px rgba(245,224,255,0.85), inset 0 1px 0 rgba(255,255,255,0.55);
            filter: brightness(1.12);
          }
        }
        /* On the narrowest mobile cards the secondary marketing chip
           collapses to icon-only so it cannot overlap the tier ribbon
           or the title. Same for the bottom content-type label. */
        @media (max-width: 380px) {
          .book-card--v78 .book-card__sheet-badge .sheet-badge__label { display: none; }
          .book-card--v78 .book-card__sheet-badge .sheet-badge { padding: 3px 6px !important; }
          .book-card--v78 .book-card__inapp [data-testid="card-inapp-badge"] span:last-child { display: none; }
          .book-card--v78 .book-card__inapp [data-testid="card-inapp-badge"] { padding: 3px 5px !important; }
        }
      `}</style>
    </motion.button>
  )
}

/**
 * Module-level cache — survives unmounts. Keys are the original `src`
 * string passed in by the parent; values are the URL in the fallback
 * chain that *actually* loaded last time. Bounded so a long session
 * never grows it indefinitely.
 */
const SUCCESS_URL_CACHE = new Map()
const HARD_FAIL_CACHE = new Set() // sources whose entire chain has failed
const CACHE_LIMIT = 256

function rememberSuccess(originalSrc, winningUrl) {
  if (!originalSrc || !winningUrl) return
  if (SUCCESS_URL_CACHE.size >= CACHE_LIMIT) {
    // FIFO drop — Map preserves insertion order
    const firstKey = SUCCESS_URL_CACHE.keys().next().value
    if (firstKey !== undefined) SUCCESS_URL_CACHE.delete(firstKey)
  }
  SUCCESS_URL_CACHE.set(originalSrc, winningUrl)
}

/**
 * CoverImage — resilient book cover with Dropbox / Drive fallback chain.
 *
 * Real-world sheets mix many share-URL shapes. The booksService normalizer
 * rewrites them once, but some Dropbox links still fail (302 → preview
 * page). We retry with alternate query params before giving up and hiding.
 *
 * v8.2 — adds a per-src success cache + memoised chain so subsequent
 * mounts skip dead variants instantly.
 *
 * v8.5 — three additions to defeat the page-switch flicker:
 *   • loading="eager" + fetchpriority="low"  (CoverPrefetcher already
 *     warmed the cache on login; eager hits now serve from cache
 *     instantly instead of re-running the lazy-load lifecycle every
 *     time the card scrolls back into view).
 *   • A subtle gradient skeleton sits BEHIND the <img> while it loads,
 *     so even on a slow first request the user never sees the empty
 *     gradient + StylizedCover blink — they see a tinted shimmer that
 *     dissolves into the cover.
 *   • The StylizedCover fallback is only rendered after the entire
 *     chain has actually failed (hardFailed). During normal loads we
 *     keep the <img> mounted with opacity transition so the swap is
 *     imperceptible.
 */
function CoverImage({ src, fallback }) {
  const chain = useMemo(() => buildFallbackChain(src), [src])

  // If we've already proven the entire chain dead for this src, render
  // the fallback immediately — no flicker, no re-fetch, no log noise.
  const hardFailed = HARD_FAIL_CACHE.has(src)

  // Seed the chain index from the success cache so the first paint
  // already targets the URL that worked last time.
  const initialIdx = (() => {
    const winner = SUCCESS_URL_CACHE.get(src)
    if (winner) {
      const i = chain.indexOf(winner)
      return i >= 0 ? i : 0
    }
    return 0
  })()

  // If we have a cached winner for this src, the next paint is going to
  // come from the browser/SW cache — start optimistic so the skeleton
  // doesn't even briefly flash for repeat visits.
  const seededWinner = SUCCESS_URL_CACHE.has(src)

  const [idx, setIdx] = useState(initialIdx)
  const [hidden, setHidden] = useState(hardFailed)
  const [loaded, setLoaded] = useState(seededWinner)

  if (hidden || !chain.length) return fallback || null

  return (
    <>
      {/* Skeleton placeholder — sits behind the <img> and dissolves out
          when the image fires onLoad. Inline styles only, no new CSS. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        data-testid="card-cover-skeleton"
        style={{
          opacity: loaded ? 0 : 1,
          transition: 'opacity 220ms ease-out',
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(212,168,67,0.10) 35%, rgba(155,92,255,0.10) 70%, rgba(255,255,255,0.04) 100%)',
        }}
      />
      <img
        src={chain[idx]}
        alt=""
        loading="eager"
        fetchpriority="low"
        decoding="async"
        referrerPolicy="no-referrer"
        className="book-card__cover pointer-events-none absolute inset-0 h-full w-full object-cover"
        data-testid="card-cover-image"
        style={{
          opacity: loaded ? 1 : 0,
          transition: 'opacity 220ms ease-out',
        }}
        onLoad={() => {
          rememberSuccess(src, chain[idx])
          setLoaded(true)
        }}
        onError={() => {
          if (idx + 1 < chain.length) {
            setIdx(idx + 1)
            setLoaded(false)
          } else {
            // Whole chain exhausted — remember so future mounts of the
            // same broken src render the fallback instantly.
            HARD_FAIL_CACHE.add(src)
            setHidden(true)
          }
        }}
      />
    </>
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
