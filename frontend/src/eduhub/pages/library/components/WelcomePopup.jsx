import { motion } from 'framer-motion'
import { GraduationCap, ArrowRight } from 'lucide-react'

export default function WelcomePopup({ name, onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-6 backdrop-blur-md"
      data-testid="welcome-popup"
    >
      <motion.div
        initial={{ scale: 0.85, y: 30, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.95, y: 10, opacity: 0 }}
        transition={{ type: 'spring', damping: 18, stiffness: 220 }}
        className="relative w-full max-w-[360px] overflow-hidden rounded-3xl border border-gold/25 p-7 text-center"
        style={{
          background:
            'linear-gradient(155deg, #2D1F3E 0%, #1A1420 100%)',
          boxShadow:
            '0 30px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(212,168,67,0.2)',
        }}
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-[#FFE19A] to-[#9C7A2C] shadow-gold-glow">
          <GraduationCap className="h-8 w-8 text-ink" strokeWidth={2.4} />
        </div>
        <h3 className="mt-5 font-display text-2xl text-parchment">
          Welcome, {name.split(' ')[0]}
        </h3>
        <p className="khmer mt-1 text-xs text-faded">សូមស្វាគមន៍!</p>
        <p className="mt-3 text-sm text-parchment/80">
          Your bookshelf is dusted off and ready. Pick a story, start a streak,
          and earn your first gem of the day.
        </p>

        <button
          onClick={onClose}
          data-testid="welcome-begin"
          className="group mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold text-ink transition-transform active:scale-[0.97]"
          style={{
            background:
              'linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)',
            boxShadow:
              '0 12px 26px rgba(212,168,67,0.4), inset 0 1px 0 rgba(255,255,255,0.6)',
          }}
        >
          Let's begin
          <span className="khmer text-xs opacity-80">ចាប់ផ្តើម</span>
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </button>
      </motion.div>
    </motion.div>
  )
}
