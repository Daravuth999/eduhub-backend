import { motion } from 'framer-motion'
import { Sparkles, Flame, Star, Gem, Clock, Crown } from 'lucide-react'

/**
 * SheetBadge — reusable, dopamine-tier animated badge shown on book
 * cards & in-reader covers. The *label* comes from the Google Sheet's
 * `badge` column (auto-upper-cased). The *look* is picked automatically
 * from a small theme table so "NEW", "FEATURED", "PREMIUM", "LIMITED",
 * "HOT", "BESTSELLER" each get a distinct color + icon, but any other
 * label still renders with the default gold-pink theme.
 *
 * Baked-in animations:
 *   • Spring-bounce on mount.
 *   • Continuous gentle breathing (scale 1 → 1.04).
 *   • Diagonal shimmer sweep every ~3 s (reader dopamine hook).
 *   • Expanding halo ring ping every ~2.4 s (limited-time FOMO cue).
 */
const THEMES = {
  NEW: {
    bg: 'linear-gradient(135deg, #8BFFC1, #21D37E)',
    color: '#063c1d',
    ring: 'rgba(33, 211, 126, 0.7)',
    icon: Sparkles,
  },
  FEATURED: {
    bg: 'linear-gradient(135deg, #FFB3D1, #E63976)',
    color: '#2b0612',
    ring: 'rgba(230, 57, 118, 0.7)',
    icon: Star,
  },
  PREMIUM: {
    // animated gold foil — the conic gradient is overridden at element level
    bg: 'linear-gradient(135deg, #FFE083, #D4A843 50%, #8A5A1F)',
    color: '#1a0f05',
    ring: 'rgba(212, 168, 67, 0.75)',
    icon: Crown,
    foil: true,
  },
  LIMITED: {
    bg: 'linear-gradient(135deg, #FFBE7A, #E63736)',
    color: '#2b0806',
    ring: 'rgba(230, 55, 54, 0.75)',
    icon: Clock,
  },
  HOT: {
    bg: 'linear-gradient(135deg, #FFD27A, #FF6A3D)',
    color: '#2b0a05',
    ring: 'rgba(255, 106, 61, 0.75)',
    icon: Flame,
  },
  BESTSELLER: {
    bg: 'linear-gradient(135deg, #C8B6FF, #8053FF)',
    color: '#1a0a3a',
    ring: 'rgba(128, 83, 255, 0.75)',
    icon: Gem,
  },
}

const DEFAULT_THEME = {
  bg: 'linear-gradient(135deg, #FFE19A, #FF8BAA 55%, #E63976)',
  color: '#2b0612',
  ring: 'rgba(230, 57, 118, 0.7)',
  icon: Sparkles,
}

/**
 * @param {string}  label       — the badge text (from the sheet).
 * @param {"sm"|"md"} size      — "sm" for cards, "md" for reader cover.
 * @param {string} className    — extra classes for positioning.
 */
export default function SheetBadge({ label, size = 'sm', className = '', testid = 'sheet-badge' }) {
  if (!label) return null
  const key = String(label).trim().toUpperCase()
  const theme = THEMES[key] || DEFAULT_THEME
  const Icon = theme.icon

  const isMd = size === 'md'
  const px = isMd ? '12px' : '8px'
  const py = isMd ? '6px' : '3px'
  const fontSize = isMd ? '11px' : '9.5px'
  const iconSize = isMd ? 12 : 10

  return (
    <motion.span
      initial={{ scale: 0.4, y: -6, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 16, delay: 0.08 }}
      className={`sheet-badge relative inline-flex items-center gap-1.5 rounded-full font-extrabold uppercase select-none ${className}`}
      style={{
        padding: `${py} ${px}`,
        fontSize,
        letterSpacing: '0.2em',
        background: theme.bg,
        color: theme.color,
        border: '1px solid rgba(255, 255, 255, 0.5)',
        boxShadow:
          `0 6px 18px -4px ${theme.ring}, inset 0 1px 0 rgba(255,255,255,0.6), inset 0 -1px 0 rgba(0,0,0,0.15)`,
        // custom CSS var consumed by the pulse/halo keyframes
        ['--badge-ring']: theme.ring,
      }}
      data-testid={testid}
      data-variant={key}
    >
      {theme.foil && <span className="sheet-badge__foil" aria-hidden />}
      <Icon style={{ width: iconSize, height: iconSize, flex: 'none' }} />
      <span className="sheet-badge__label">{label}</span>
      <span className="sheet-badge__shimmer" aria-hidden />
      <span className="sheet-badge__halo" aria-hidden />
    </motion.span>
  )
}
