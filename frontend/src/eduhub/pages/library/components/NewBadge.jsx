/**
 * NewBadge — "Golden" animated pill (v7.9.6)
 *
 * Used by BookCard whenever `item._isNew` is true. The flag is set by
 * booksService:
 *   1) instructor's `newUntil` column is in the future, OR
 *   2) this browser first saw the slug < 7 days ago (client-discovered).
 *
 * v7.9.6 — label simplified "Live · New" → "New" and pill tightened to
 * fit the new bottom-right placement without colliding with the sheet
 * `badge` pill in the top-right corner.
 */
export default function NewBadge() {
  return (
    <span
      className="new-badge-orbits relative inline-flex items-center justify-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-ink"
      style={{
        background:
          'conic-gradient(from 200deg, #FFD700, #FFF7C2, #D4A843, #FFE98A, #FFD700)',
        boxShadow:
          '0 0 14px rgba(255,215,0,0.65), 0 0 26px rgba(255,215,0,0.35), inset 0 1px 0 rgba(255,255,255,0.7)',
        animation:
          'goldenLivePulse 2.2s ease-in-out infinite, goldenLiveSpin 9s linear infinite',
      }}
      data-testid="new-badge"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: '#1a1420',
          boxShadow: '0 0 6px #1a1420, 0 0 10px rgba(255,215,0,0.9)',
          animation: 'goldenLiveDot 1s ease-in-out infinite',
        }}
      />
      New
      <span className="sparkle animate-orbit" style={{ animationDelay: '0s' }} />
      <span
        className="sparkle animate-orbit"
        style={{ animationDelay: '-1.3s', animationDuration: '4s' }}
      />
      <span
        className="sparkle animate-orbit"
        style={{ animationDelay: '-2.6s', animationDuration: '4s' }}
      />
      <style>{`
        @keyframes goldenLivePulse {
          0%, 100% {
            box-shadow: 0 0 14px rgba(255,215,0,0.65),
                        0 0 26px rgba(255,215,0,0.35),
                        inset 0 1px 0 rgba(255,255,255,0.7);
            transform: scale(1);
          }
          50% {
            box-shadow: 0 0 22px rgba(255,215,0,0.9),
                        0 0 44px rgba(255,215,0,0.55),
                        inset 0 1px 0 rgba(255,255,255,0.9);
            transform: scale(1.06);
          }
        }
        @keyframes goldenLiveSpin {
          to { filter: hue-rotate(15deg); }
        }
        @keyframes goldenLiveDot {
          0%, 100% { opacity: 1;   transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.7); }
        }
      `}</style>
    </span>
  )
}
