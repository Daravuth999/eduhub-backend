import { motion } from "framer-motion";
import { Trophy } from "lucide-react";
import { parseHistoryEntry } from "../lib/shopApi";

interface WinnersTickerProps {
  history: string[];
}

// Anonymise — show only the item, not the redeeming user. Real data, no fakery.
export function WinnersTicker({ history }: WinnersTickerProps) {
  const items = history
    .slice(0, 14)
    .map((raw) => parseHistoryEntry(raw))
    .filter((h) => h.itemName);

  if (items.length === 0) return null;
  // Duplicate so the marquee loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="relative w-full overflow-hidden rounded-full border border-white/10 bg-black/40 py-1.5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12"
        style={{
          background:
            "linear-gradient(90deg, rgba(11,5,32,1), rgba(11,5,32,0))",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12"
        style={{
          background:
            "linear-gradient(90deg, rgba(11,5,32,0), rgba(11,5,32,1))",
        }}
      />
      <motion.div
        className="flex gap-6 whitespace-nowrap"
        animate={{ x: ["0%", "-50%"] }}
        transition={{ duration: items.length * 5, repeat: Infinity, ease: "linear" }}
      >
        {loop.map((h, i) => (
          <span
            key={`${h.raw}-${i}`}
            className="flex items-center gap-2 text-[11px] font-semibold text-white/80"
          >
            <Trophy className="h-3 w-3 text-[#FFD85C]" />
            <span className="text-[#13C2C2]">Just redeemed</span>
            <span className="text-white">{h.itemName}</span>
            {h.points && (
              <span className="rounded-full bg-[#FF4081]/15 px-1.5 py-0.5 text-[9px] font-bold text-[#FF4081]">
                {h.points}
              </span>
            )}
          </span>
        ))}
      </motion.div>
    </div>
  );
}
