import { motion } from 'framer-motion'
import { BookOpen, X } from 'lucide-react'
import { useEffect } from 'react'

export default function ConfirmModal({ item, meta, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-5 backdrop-blur-md"
      data-testid="confirm-modal"
    >
      <motion.div
        initial={{ scale: 0.9, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.95, y: 10, opacity: 0 }}
        transition={{ type: 'spring', damping: 22, stiffness: 240 }}
        className="relative w-full max-w-[380px] overflow-hidden rounded-3xl border border-gold/25 p-6"
        style={{
          background:
            'linear-gradient(160deg, #2A1F38 0%, #1A1420 100%)',
          boxShadow:
            '0 30px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(212,168,67,0.18)',
        }}
      >
        <button
          onClick={onCancel}
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-faded hover:text-parchment"
          aria-label="Close"
          data-testid="modal-close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 flex items-center gap-3">
          <div
            className="grid h-12 w-12 place-items-center rounded-2xl text-parchment"
            style={{ background: meta.gradient }}
          >
            <BookOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.2em] text-faded">
              {meta.label}
            </p>
            <h3 className="line-clamp-2 font-display text-[18px] leading-tight text-parchment">
              {item.title}
            </h3>
          </div>
        </div>

        <p className="text-sm text-parchment/80">
          Ready to start this lesson?
        </p>
        <p className="khmer mt-1 text-xs text-faded">
          ត្រៀមខ្លួនរៀនមេរៀននេះ?
        </p>
        <p className="mt-3 text-[12px] text-faded">
          Your points will be added after we open the lesson in a new tab.
        </p>

        <div className="mt-5 flex gap-2.5">
          <button
            onClick={onCancel}
            data-testid="modal-cancel"
            className="flex-1 rounded-xl border border-parchment/15 bg-walnut/70 py-3 text-sm font-medium text-parchment transition-colors hover:border-magenta/40 hover:text-[#FFB7CF]"
          >
            <span>Cancel</span>
            <span className="khmer ml-1.5 text-xs text-faded">បោះបង់</span>
          </button>
          <button
            onClick={onConfirm}
            data-testid="modal-confirm"
            className="flex-1 rounded-xl py-3 text-sm font-semibold text-ink transition-transform active:scale-[0.97]"
            style={{
              background:
                'linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)',
              boxShadow:
                '0 10px 22px rgba(212,168,67,0.35), inset 0 1px 0 rgba(255,255,255,0.6)',
            }}
          >
            <span>Start Lesson</span>
            <span className="khmer ml-1.5 text-xs opacity-80">ចាប់ផ្តើម</span>
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
