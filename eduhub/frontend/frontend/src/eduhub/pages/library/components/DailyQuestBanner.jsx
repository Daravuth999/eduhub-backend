import { Sparkles } from 'lucide-react'

export default function DailyQuestBanner({ completed, streak }) {
  const goal = 3
  // Compute a "today" view by storing the baseline of completedLessons at midnight.
  const today = new Date().toISOString().slice(0, 10)
  let baseline = Number(localStorage.getItem(`cl-baseline-${today}`))
  if (Number.isNaN(baseline) || !baseline) {
    if (localStorage.getItem('cl-last-baseline-date') !== today) {
      localStorage.setItem(`cl-baseline-${today}`, String(completed))
      localStorage.setItem('cl-last-baseline-date', today)
      baseline = completed
    } else {
      baseline = completed
    }
  }
  const todayDone = Math.max(0, Math.min(goal, completed - baseline))
  const pct = Math.min(100, (todayDone / goal) * 100)

  return (
    <div
      className="shimmer-sweep relative mt-3 overflow-hidden rounded-2xl border border-gold/25 px-4 py-3"
      style={{
        background:
          'linear-gradient(120deg, rgba(212,168,67,0.18), rgba(45,106,79,0.16))',
      }}
      data-testid="daily-quest-banner"
    >
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gold/20 text-gold">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] leading-tight text-parchment">
            Daily Quest · Read {goal} lessons today
          </p>
          <p className="khmer text-[11px] text-faded">
            បេសកកម្មប្រចាំថ្ងៃ · សូមអានឱ្យបាន {goal} មេរៀន
          </p>
        </div>
        <span className="tabular shrink-0 rounded-full border border-gold/30 px-2 py-1 text-[11px] text-gold">
          {todayDone}/{goal}
        </span>
      </div>
      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-ink/70">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${pct}%`,
            background:
              'linear-gradient(90deg, #D4A843 0%, #FFE19A 50%, #00BFA5 100%)',
            boxShadow: '0 0 10px rgba(212,168,67,0.5)',
          }}
        />
      </div>
      <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-faded">
        Streak {streak}d · Keep going
      </p>
    </div>
  )
}
