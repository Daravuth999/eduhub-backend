import { motion } from 'framer-motion'
import { Gem } from 'lucide-react'

export default function PointsToast({ points }) {
  return (
    <motion.div
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 60, opacity: 0 }}
      transition={{ type: 'spring', damping: 22, stiffness: 240 }}
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      data-testid="points-toast"
    >
      <div
        className="flex items-center gap-2.5 rounded-full border border-gold/40 px-4 py-2.5 text-sm font-medium text-parchment"
        style={{
          background:
            'linear-gradient(135deg, rgba(45,106,79,0.95) 0%, rgba(26,20,32,0.95) 100%)',
          boxShadow:
            '0 18px 40px rgba(0,0,0,0.5), 0 0 18px rgba(212,168,67,0.35)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <Gem className="h-4 w-4 text-teal" />
        <span className="tabular">+{points} pts</span>
        <span className="khmer text-xs text-faded">បានពិន្ទុ!</span>
        <span aria-hidden="true">💎</span>
      </div>
    </motion.div>
  )
}
