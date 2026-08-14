import { AnimatePresence, motion } from "framer-motion";
import {
  Loader2,
  Flame,
  Target,
  ChevronDown,
  Sparkles,
  Gift,
} from "lucide-react";
import { useState } from "react";
import type { Prize } from "../lib/api";
import type { HistoryEntry } from "../lib/history";
import { SpinWheel } from "./SpinWheel";
import { HistoryPanel } from "./HistoryPanel";
import { WinnersTicker } from "./WinnersTicker";

interface SpinPanelProps {
  prizes: Prize[];
  rotation: number;
  isSpinning: boolean;
  isPreloading: boolean;
  spinCost: number | null;
  statusMsg: string;
  history: HistoryEntry[];
  shopHistory: string[];
  prizeImages: Record<string, string>;
  winningIndex: number | null;
  streak: number;
  isMysterySpin: boolean;
  isIdle: boolean;
  onSpin: () => void;
  onWheelStop: () => void;
  onTick: () => void;
  onClearHistory: () => void;
}

export function SpinPanel({
  prizes,
  rotation,
  isSpinning,
  isPreloading,
  spinCost,
  statusMsg,
  history,
  shopHistory,
  prizeImages,
  winningIndex,
  streak,
  isMysterySpin,
  isIdle,
  onSpin,
  onWheelStop,
  onTick,
  onClearHistory,
}: SpinPanelProps) {
  const [showPrizes, setShowPrizes] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="flex w-full flex-col items-center gap-5"
      data-testid="spin-panel"
    >
      <div className="text-center">
        <motion.h1
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="text-2xl font-extrabold tracking-[2px] text-gradient-gold drop-shadow-[0_0_20px_rgba(255,216,92,0.4)] sm:text-4xl"
        >
          LUCKY SPIN ROYALE
        </motion.h1>
        <p className="text-xs text-white/60 sm:text-sm">
          Spin the wheel and earn points to redeem prizes
        </p>
      </div>

      <div className="flex w-full flex-col items-center gap-5 lg:flex-row lg:items-start lg:justify-center lg:gap-8">
        <div className="flex w-full max-w-[500px] flex-col items-center gap-4 lg:w-auto lg:max-w-none">
          {prizes.length > 0 ? (
            <SpinWheel
              prizes={prizes}
              rotation={rotation}
              isSpinning={isSpinning}
              isLoading={isPreloading}
              onAnimationComplete={onWheelStop}
              onTick={onTick}
              prizeImages={prizeImages}
              winningIndex={winningIndex}
            />
          ) : (
            <div className="flex aspect-square w-full max-w-[500px] items-center justify-center">
              <Loader2 className="h-12 w-12 animate-spin text-[#FFD85C]" />
            </div>
          )}

          <div className="flex w-full flex-col items-center gap-2">
            {/* Streak badge */}
            <AnimatePresence>
              {streak >= 2 && !isSpinning && (
                <motion.div
                  key={`streak-${streak}`}
                  initial={{ opacity: 0, scale: 0.6, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="flex items-center gap-1.5 rounded-full border border-[#FF4081]/40 bg-[#FF4081]/15 px-3 py-1 text-[11px] font-bold text-[#FF4081]"
                >
                  <Flame className="h-3.5 w-3.5" />
                  {streak}-WIN STREAK
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              onClick={onSpin}
              whileHover={
                !isSpinning && !isPreloading ? { scale: 1.1 } : undefined
              }
              whileTap={
                !isSpinning && !isPreloading ? { scale: 0.9 } : undefined
              }
              animate={
                isIdle && !isSpinning && !isPreloading
                  ? {
                      scale: [1, 1.06, 1],
                      boxShadow: [
                        "0 8px 25px rgba(255,64,129,0.5)",
                        "0 12px 38px rgba(255,216,92,0.65)",
                        "0 8px 25px rgba(255,64,129,0.5)",
                      ],
                    }
                  : undefined
              }
              transition={
                isIdle && !isSpinning && !isPreloading
                  ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
                  : undefined
              }
              disabled={isSpinning || isPreloading || prizes.length === 0}
              className="relative flex w-full max-w-xs items-center justify-center gap-3 overflow-hidden rounded-full px-10 py-4 text-lg font-bold tracking-wider text-white shadow-[0_8px_25px_rgba(255,64,129,0.5)] transition disabled:opacity-60 sm:text-xl"
              style={{
                background:
                  isSpinning || isPreloading
                    ? "linear-gradient(135deg, #555, #777)"
                    : isMysterySpin
                    ? "linear-gradient(135deg, #FFD85C, #FF4081, #7C3AED)"
                    : "linear-gradient(135deg, #FF4081, #D81B60)",
                backgroundSize: isMysterySpin ? "200% 100%" : undefined,
              }}
              data-testid="spin-now-btn"
            >
              {/* Mystery shimmer sweep */}
              {isMysterySpin && !isSpinning && !isPreloading && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 -translate-x-full"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)",
                  }}
                  animate={{ x: ["-100%", "200%"] }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                />
              )}
              {isPreloading || isSpinning ? (
                <Loader2 className="relative h-6 w-6 animate-spin" />
              ) : isMysterySpin ? (
                <Gift className="relative h-6 w-6" />
              ) : (
                <Flame className="relative h-6 w-6" />
              )}
              <span className="relative">
                {isPreloading
                  ? "PREPARING..."
                  : isSpinning
                  ? "SPINNING..."
                  : isMysterySpin
                  ? "MYSTERY SPIN!"
                  : "SPIN NOW"}
              </span>
            </motion.button>

            {spinCost != null && (
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-1.5 text-xs">
                <Target className="h-3.5 w-3.5 text-[#FFD85C]" />
                <span className="text-white/70">Cost</span>
                <span className="font-bold text-[#FFD85C]">
                  {spinCost} pt{spinCost !== 1 ? "s" : ""}
                </span>
                {isMysterySpin && (
                  <span className="ml-1 flex items-center gap-1 rounded-full bg-[#FF4081]/15 px-2 py-0.5 text-[10px] font-bold text-[#FF4081]">
                    <Sparkles className="h-3 w-3" />
                    BONUS UP
                  </span>
                )}
              </div>
            )}

            {statusMsg && (
              <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-center text-sm font-semibold">
                {statusMsg}
              </div>
            )}
          </div>
        </div>

        <div className="w-full max-w-[500px] lg:max-w-none">
          <HistoryPanel entries={history} onClear={onClearHistory} />
        </div>
      </div>

      {/* Live winners ticker — fed by REAL Shop GAS redemption history */}
      {shopHistory.length > 0 && (
        <div className="w-full max-w-3xl">
          <WinnersTicker history={shopHistory} />
        </div>
      )}

      {/* Prize Board (segment legend) */}
      {prizes.length > 0 && (
        <div className="w-full max-w-3xl">
          <button
            onClick={() => setShowPrizes((v) => !v)}
            className="glass flex w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold text-white/90 transition hover:bg-white/[0.08]"
            data-testid="prize-board-toggle"
          >
            <span className="flex items-center gap-2">
              <Target className="h-4 w-4 text-[#FFD85C]" />
              Wheel Segments
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/70">
                {prizes.length}
              </span>
            </span>
            <motion.span
              animate={{ rotate: showPrizes ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className="h-4 w-4 text-white/60" />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {showPrizes && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="glass mt-2 grid grid-cols-2 gap-2 rounded-xl p-3 sm:grid-cols-3 md:grid-cols-4">
                  {prizes.map((prize, i) => (
                    <div
                      key={`${prize.PrizeName}-${i}`}
                      className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/25 px-3 py-2"
                    >
                      <span className="text-xl">{prize.Emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-white/90">
                          {prize.PrizeName}
                        </div>
                        <div className="text-[10px] font-bold text-[#FFD85C]">
                          {prize.RewardPoints} pts
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
