import { motion } from "framer-motion";
import { Gift, ArrowRight, Sparkles } from "lucide-react";
import type { Reward } from "../lib/shopApi";

interface PeekPanelProps {
  mode: "spin" | "vault";
  rewards: Reward[];
  points: number;
  onSwitch: () => void;
}

export function PeekPanel({ mode, rewards, points, onSwitch }: PeekPanelProps) {
  if (mode === "spin") {
    const top = rewards
      .filter((r) => Number(r.Stock ?? 0) > 0)
      .sort((a, b) => a.PointCost - b.PointCost)
      .slice(0, 3);
    const affordable = rewards.filter(
      (r) => points >= r.PointCost && Number(r.Stock ?? 0) > 0,
    ).length;

    return (
      <motion.aside
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        className="glass relative w-full overflow-hidden rounded-2xl p-4 lg:w-72"
      >
        <motion.div
          className="absolute inset-x-0 top-0 h-[2px]"
          style={{
            background:
              "linear-gradient(90deg, transparent, #FF4081, #FFD85C, #13C2C2, transparent)",
          }}
          animate={{ backgroundPositionX: ["0%", "200%"] }}
          transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
        />
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FF4081]/15">
            <Gift className="h-4 w-4 text-[#FF4081]" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Reward Vault</h3>
            <p className="text-[10px] uppercase tracking-wider text-white/50">
              {affordable} you can claim now
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {top.length === 0 ? (
            <p className="rounded-lg bg-black/25 px-3 py-2 text-xs text-white/60">
              Loading prizes…
            </p>
          ) : (
            top.map((r) => (
              <div
                key={r.ItemName}
                className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/30 px-2.5 py-2"
              >
                {r.Image ? (
                  <img
                    src={r.Image}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/10">
                    <Sparkles className="h-4 w-4 text-[#FFD85C]" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-white">
                    {r.ItemName}
                  </div>
                  <div className="text-[10px] font-bold text-[#FFD85C]">
                    {r.PointCost} pts
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={onSwitch}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold text-white shadow-[0_6px_20px_rgba(255,64,129,0.4)]"
          style={{
            background: "linear-gradient(135deg, #FF4081, #D81B60)",
          }}
          data-testid="peek-open-vault-btn"
        >
          OPEN VAULT
          <ArrowRight className="h-3.5 w-3.5" />
        </motion.button>
      </motion.aside>
    );
  }

  // mode === "vault": tease the wheel
  return (
    <motion.aside
      initial={{ opacity: 0, x: -30 }}
      animate={{ opacity: 1, x: 0 }}
      className="glass relative w-full overflow-hidden rounded-2xl p-4 lg:w-72"
    >
      <motion.div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #FFD85C, #13C2C2, #FF4081, transparent)",
        }}
        animate={{ backgroundPositionX: ["0%", "200%"] }}
        transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
      />

      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FFD85C]/15">
          <Sparkles className="h-4 w-4 text-[#FFD85C]" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">Lucky Spin</h3>
          <p className="text-[10px] uppercase tracking-wider text-white/50">
            Earn points to redeem
          </p>
        </div>
      </div>

      {/* Mini animated wheel preview */}
      <div className="relative mx-auto my-2 aspect-square w-32">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "conic-gradient(#FFD85C 0deg 45deg, #13C2C2 45deg 90deg, #FF4081 90deg 135deg, #7C3AED 135deg 180deg, #10B981 180deg 225deg, #F97316 225deg 270deg, #3B82F6 270deg 315deg, #EC4899 315deg 360deg)",
            boxShadow:
              "0 0 25px rgba(255,216,92,0.45), inset 0 0 12px rgba(0,0,0,0.5)",
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
        />
        <div className="absolute inset-[36%] rounded-full bg-[#0B0520] ring-2 ring-[#FFD85C]" />
        <div
          className="absolute left-1/2 top-0 h-5 w-4 -translate-x-1/2"
          style={{
            background: "linear-gradient(180deg, #FFD85C, #F59E0B)",
            clipPath: "polygon(50% 100%, 0% 0%, 100% 0%)",
          }}
        />
      </div>

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        onClick={onSwitch}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold text-white shadow-[0_6px_20px_rgba(19,194,194,0.4)]"
        style={{
          background: "linear-gradient(135deg, #13C2C2, #0D9488)",
        }}
        data-testid="peek-open-spin-btn"
      >
        BACK TO SPIN
        <ArrowRight className="h-3.5 w-3.5" />
      </motion.button>
    </motion.aside>
  );
}
