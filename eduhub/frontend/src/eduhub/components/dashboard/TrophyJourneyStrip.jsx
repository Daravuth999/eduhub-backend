// TrophyJourneyStrip.jsx — compact achievement-journey preview for the
// Learning Progress card (Dashboard).
//
// Answers, in ~90px of vertical space, the questions a first-time student
// actually has: What is my current achievement? How many tiers exist?
// What's next, and how close am I? Is there a reward waiting?
//
// Reads ONLY the existing GET /api/achievements/me payload (via
// useAchievements) — no new endpoints, no changed calculations. The
// "toward next" percentage is a display-only average of the backend's own
// per-requirement fractions; unlock logic stays 100% server-side.
import { Gift, Lock } from "lucide-react";

// Display-only aggregate of the backend's per-requirement fractions.
export function nextTrophyFraction(next) {
  const rows = next?.progress || [];
  if (!rows.length) return 0;
  return Math.min(1, rows.reduce((a, r) => a + (r.fraction || 0), 0) / rows.length);
}

export function claimableCount(data) {
  return (data?.trophies || []).filter((t) => t.claimable).length;
}

export default function TrophyJourneyStrip({ data }) {
  const trophies = data?.trophies || [];
  if (!trophies.length) return null;

  const current = trophies.find((t) => t.trophy_id === data.current_trophy_id) || null;
  const next = trophies.find((t) => t.trophy_id === data.next_trophy_id) || null;
  const unlockedCount = data?.summary?.unlocked_count ?? trophies.filter((t) => t.unlocked).length;
  const claimable = claimableCount(data);
  const pct = Math.round(nextTrophyFraction(next) * 100);

  return (
    <div data-testid="trophy-journey-strip">
      {/* Current achievement — name + why it matters, one line each */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[9.5px] uppercase tracking-wide font-bold text-zinc-400 dark:text-white/35">
            {current ? "Current achievement" : "Your first trophy"}
          </p>
          <p className="text-[0.98rem] font-extrabold text-ink dark:text-white truncate" data-testid="journey-current-name">
            {current ? current.name : next ? next.name : trophies[0].name}
          </p>
        </div>
        <p className="shrink-0 text-[0.72rem] font-bold text-zinc-400 dark:text-white/40" data-testid="journey-count">
          <span className="text-violet-500 dark:text-violet-300">{unlockedCount}</span> of {trophies.length} unlocked
        </p>
      </div>

      {/* The journey itself — all five tiers, always visible */}
      <div className="flex items-center mt-2" aria-hidden data-testid="journey-tier-row">
        {trophies.map((t, i) => (
          <span key={t.trophy_id} className="flex items-center flex-1 last:flex-none">
            <span
              className="relative shrink-0 w-8 h-8 rounded-full flex items-center justify-center border"
              style={{
                borderColor: t.unlocked ? "rgba(139,92,246,0.45)" : "rgba(161,161,170,0.25)",
                background: t.unlocked ? "rgba(139,92,246,0.08)" : "rgba(161,161,170,0.06)",
              }}
              data-testid={`journey-trophy-${t.trophy_id}`}
            >
              <img
                src={t.artwork}
                alt={t.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="w-6 h-6 object-contain"
                style={t.unlocked ? undefined : { filter: "grayscale(1) opacity(0.45)" }}
              />
              {!t.unlocked && (
                <Lock className="absolute -bottom-0.5 -right-0.5 w-3 h-3 p-[1.5px] rounded-full bg-white dark:bg-[#241d38] text-zinc-400 dark:text-white/45" />
              )}
            </span>
            {i < trophies.length - 1 && (
              <span
                className="flex-1 h-[2px] mx-1 rounded-full"
                style={{ background: t.unlocked ? "rgba(139,92,246,0.45)" : "rgba(161,161,170,0.2)" }}
              />
            )}
          </span>
        ))}
      </div>

      {/* Next achievement — the single motivating number */}
      {next && (
        <div className="mt-2" data-testid="journey-next-progress">
          <div className="flex items-baseline justify-between">
            <p className="text-[0.72rem] font-semibold text-zinc-500 dark:text-white/50 truncate">
              Next: <span className="font-bold text-ink dark:text-white">{next.name}</span>
              {next.reward?.points > 0 && (
                <span className="text-violet-500 dark:text-violet-300 font-bold"> · +{next.reward.points.toLocaleString()} pts</span>
              )}
            </p>
            <p className="shrink-0 text-[0.72rem] font-bold text-violet-500 dark:text-violet-300 ml-2">{pct}%</p>
          </div>
          <div className="h-1 mt-1 rounded-full bg-zinc-100 dark:bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.max(3, pct)}%`, background: "linear-gradient(90deg,#8B5CF6,#A78BFA)" }}
            />
          </div>
        </div>
      )}

      {/* One line of Khmer guidance — reward motivation, not decoration */}
      <p className="font-khmer text-[0.7rem] text-zinc-400 dark:text-white/40 mt-2 truncate" data-testid="journey-khmer-hint">
        {claimable > 0
          ? "អ្នកមានរង្វាន់រង់ចាំ · ចុចដើម្បីទទួល"
          : "ពាននីមួយៗអមដោយពិន្ទុរង្វាន់ · ចុចដើម្បីមើល"}
        {claimable > 0 && <Gift className="inline w-3 h-3 ml-1 text-amber-500 align-[-2px]" />}
      </p>
    </div>
  );
}
