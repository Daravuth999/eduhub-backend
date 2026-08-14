import { motion } from 'framer-motion'

export default function LevelBar({ level, xp }) {
  // XP within current level: assume 1000 XP per level for the bar visual.
  const span = 1000
  const inLevel = ((Number(xp) || 0) % span)
  const pct = Math.max(2, Math.min(100, (inLevel / span) * 100))

  return (
    <div className="mt-3 rounded-2xl border border-parchment/10 bg-walnut/60 px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-faded">
        <span>Reader Level</span>
        <span className="tabular text-parchment">
          Lv. {level} · {inLevel}/{span} XP
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-ink/70">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{
            background:
              'linear-gradient(90deg, #2D6A4F 0%, #00BFA5 50%, #D4A843 100%)',
            boxShadow: '0 0 14px rgba(0,191,165,0.45)',
          }}
        />
      </div>
    </div>
  )
}
