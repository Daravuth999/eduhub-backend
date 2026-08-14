import { AnimatePresence, motion } from "framer-motion";
import {
  History,
  Crown,
  TrendingUp,
  TrendingDown,
  Trash2,
  Inbox,
} from "lucide-react";
import type { HistoryEntry } from "../lib/history";

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onClear: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function HistoryPanel({ entries, onClear }: HistoryPanelProps) {
  const wins = entries.filter((e) => e.change > 0).length;
  const totalChange = entries.reduce((sum, e) => sum + e.change, 0);

  return (
    <div className="glass relative flex w-full flex-col overflow-hidden rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.25)] lg:w-80">
      {/* Animated gradient border accent */}
      <motion.div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #FFD85C, #13C2C2, #FF4081, transparent)",
        }}
        animate={{ backgroundPositionX: ["0%", "200%"] }}
        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FFD85C]/15">
            <History className="h-4 w-4 text-[#FFD85C]" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Play History</h3>
            <p className="text-[10px] uppercase tracking-wider text-white/50">
              Your last spins
            </p>
          </div>
        </div>
        {entries.length > 0 && (
          <button
            onClick={onClear}
            className="rounded-lg p-2 text-white/50 transition hover:bg-white/10 hover:text-[#FF4081]"
            aria-label="Clear history"
            title="Clear history"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Stats strip */}
      {entries.length > 0 && (
        <div className="grid grid-cols-3 gap-2 border-b border-white/10 px-4 py-3 text-center">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              Spins
            </div>
            <div className="text-lg font-bold text-white">{entries.length}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              Wins
            </div>
            <div className="text-lg font-bold text-[#13C2C2]">{wins}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              Net
            </div>
            <div
              className={`text-lg font-bold ${
                totalChange > 0
                  ? "text-[#FFD85C]"
                  : totalChange < 0
                  ? "text-[#FF4081]"
                  : "text-white/70"
              }`}
            >
              {totalChange > 0 ? "+" : ""}
              {totalChange}
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="max-h-[420px] overflow-y-auto lg:max-h-[480px]">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <Inbox className="h-8 w-8 text-white/30" />
            <p className="text-sm text-white/50">No spins yet</p>
            <p className="text-xs text-white/40">
              Your prize history will appear here
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            <AnimatePresence initial={false}>
              {entries.map((e) => (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: 30, scale: 0.95 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -30 }}
                  transition={{ type: "spring", stiffness: 280, damping: 22 }}
                  className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-white/[0.04]"
                >
                  <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/30 text-xl">
                    {e.emoji}
                    {e.isJackpot && (
                      <Crown className="absolute -right-1.5 -top-1.5 h-4 w-4 text-[#FFD85C] drop-shadow-[0_0_4px_rgba(255,216,92,0.9)]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">
                      {e.prize}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      {timeAgo(e.timestamp)}
                    </div>
                  </div>
                  <div
                    className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold ${
                      e.change > 0
                        ? "bg-[#13C2C2]/15 text-[#13C2C2]"
                        : "bg-white/5 text-white/50"
                    }`}
                  >
                    {e.change > 0 ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : (
                      <TrendingDown className="h-3 w-3" />
                    )}
                    {e.change > 0 ? `+${e.change}` : e.change || "0"}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
