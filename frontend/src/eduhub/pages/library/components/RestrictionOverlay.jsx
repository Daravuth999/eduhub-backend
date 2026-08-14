import { motion } from 'framer-motion'
import { Lock, LogOut } from 'lucide-react'

export default function RestrictionOverlay({ message, onLogout }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/85 px-6 backdrop-blur-xl"
      data-testid="restriction-overlay"
    >
      <motion.div
        initial={{ scale: 0.9, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: 'spring', damping: 22, stiffness: 220 }}
        className="w-full max-w-[400px] rounded-3xl border border-magenta/35 p-7 text-center"
        style={{
          background:
            'linear-gradient(155deg, #2A1622 0%, #1A1420 100%)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
        }}
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-magenta/20 text-magenta">
          <Lock className="h-7 w-7" />
        </div>
        <h3 className="mt-5 font-display text-2xl text-parchment">
          Account Restricted
        </h3>
        <p className="khmer mt-1 text-xs text-faded">
          គណនីត្រូវបានរឹតបន្តឹង
        </p>
        <p className="mt-4 text-sm text-parchment/80">{message}</p>
        <button
          onClick={onLogout}
          data-testid="restriction-logout"
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl border border-parchment/20 bg-walnut px-5 py-3 text-sm font-medium text-parchment hover:border-gold/40"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </motion.div>
    </motion.div>
  )
}
