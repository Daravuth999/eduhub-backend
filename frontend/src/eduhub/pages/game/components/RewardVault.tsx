import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Search,
  Gift,
  PackageX,
  Coins,
  Sparkles,
  Loader2,
  CheckCircle2,
  Clock,
  Filter,
  X,
  Copy,
} from "lucide-react";
import type { Reward } from "../lib/shopApi";
import { parseHistoryEntry } from "../lib/shopApi";

interface RewardVaultProps {
  rewards: Reward[];
  history: string[];
  points: number;
  loadingRewards: boolean;
  redeemingItem: string | null;
  giftCode: string | null;
  onRedeem: (reward: Reward) => void;
  onCloseGiftCode: () => void;
}

export function RewardVault({
  rewards,
  history,
  points,
  loadingRewards,
  redeemingItem,
  giftCode,
  onRedeem,
  onCloseGiftCode,
}: RewardVaultProps) {
  const [query, setQuery] = useState("");
  const [onlyAffordable, setOnlyAffordable] = useState(false);
  const [sortBy, setSortBy] = useState<"cost-asc" | "cost-desc">("cost-asc");

  const visible = useMemo(() => {
    let list = rewards.filter((r) =>
      r.ItemName.toLowerCase().includes(query.toLowerCase()),
    );
    if (onlyAffordable) {
      list = list.filter(
        (r) => points >= r.PointCost && Number(r.Stock ?? 0) > 0,
      );
    }
    list = [...list].sort((a, b) =>
      sortBy === "cost-asc"
        ? a.PointCost - b.PointCost
        : b.PointCost - a.PointCost,
    );
    return list;
  }, [rewards, query, onlyAffordable, sortBy, points]);

  const parsedHistory = useMemo(
    () => history.map((raw) => parseHistoryEntry(raw)).filter((h) => h.itemName),
    [history],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="flex w-full flex-col gap-5"
      data-testid="reward-vault"
    >
      {/* Vault header */}
      <div className="glass rounded-2xl p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-extrabold tracking-wider text-gradient-gold sm:text-3xl">
              REWARD VAULT
            </h2>
            <p className="text-xs text-white/60 sm:text-sm">
              Spend your points on real prizes
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm">
            <Coins className="h-4 w-4 text-[#FFD85C]" />
            <span className="text-white/70">Balance</span>
            <span className="font-bold text-[#FFD85C]">{points} pts</span>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rewards…"
              className="w-full rounded-xl border border-white/15 bg-black/25 py-2.5 pl-10 pr-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#FFD85C] focus:ring-2 focus:ring-[#FFD85C]/30"
              data-testid="vault-search-input"
            />
          </div>
          <button
            onClick={() => setOnlyAffordable((v) => !v)}
            className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold transition ${
              onlyAffordable
                ? "border-[#13C2C2]/60 bg-[#13C2C2]/15 text-[#13C2C2]"
                : "border-white/10 bg-black/25 text-white/70 hover:bg-white/10"
            }`}
            data-testid="vault-filter-affordable"
          >
            <Filter className="h-3.5 w-3.5" />
            Affordable
          </button>
          <select
            value={sortBy}
            onChange={(e) =>
              setSortBy(e.target.value as "cost-asc" | "cost-desc")
            }
            className="rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-xs font-semibold text-white/80 outline-none focus:border-[#FFD85C]"
            data-testid="vault-sort-select"
          >
            <option value="cost-asc">Cost: Low → High</option>
            <option value="cost-desc">Cost: High → Low</option>
          </select>
        </div>
      </div>

      {/* Reward grid */}
      {loadingRewards ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-10 w-10 animate-spin text-[#FFD85C]" />
        </div>
      ) : visible.length === 0 ? (
        <div className="glass flex flex-col items-center justify-center gap-2 rounded-2xl py-12 text-center">
          <PackageX className="h-10 w-10 text-white/40" />
          <p className="text-sm text-white/60">No rewards match your filters.</p>
        </div>
      ) : (
        <div
          className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
          data-testid="reward-grid"
        >
          {visible.map((reward) => {
            const stock = Number(reward.Stock ?? 0);
            const inStock = stock > 0;
            const canAfford = points >= reward.PointCost;
            const disabled = !inStock || !canAfford;
            const busy = redeemingItem === reward.ItemName;

            return (
              <motion.div
                key={reward.ItemName}
                whileHover={{ y: -3 }}
                transition={{ type: "spring", stiffness: 260, damping: 20 }}
                className="glass group relative flex flex-col overflow-hidden rounded-xl"
              >
                <div className="relative aspect-square overflow-hidden bg-black/30">
                  {reward.Image ? (
                    <img
                      src={reward.Image}
                      alt={reward.ItemName}
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Sparkles className="h-8 w-8 text-[#FFD85C]/60" />
                    </div>
                  )}
                  <div className="absolute right-1.5 top-1.5 rounded-full border border-white/15 bg-black/60 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider backdrop-blur">
                    {inStock ? (
                      <span className="text-[#13C2C2]">{stock} left</span>
                    ) : (
                      <span className="text-[#FF4081]">Sold</span>
                    )}
                  </div>
                  <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-[#FFD85C]/95 px-2 py-0.5 text-[10px] font-bold text-[#0B0520]">
                    <Coins className="h-2.5 w-2.5" />
                    {reward.PointCost}
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                  <h3 className="line-clamp-1 text-xs font-bold text-white">
                    {reward.ItemName}
                  </h3>
                  {reward.Description && (
                    <p className="line-clamp-2 text-[10px] leading-tight text-white/55">
                      {reward.Description}
                    </p>
                  )}
                  <motion.button
                    whileHover={!disabled && !busy ? { scale: 1.03 } : undefined}
                    whileTap={!disabled && !busy ? { scale: 0.97 } : undefined}
                    onClick={() => onRedeem(reward)}
                    disabled={disabled || busy}
                    className="mt-auto flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      background: disabled
                        ? "linear-gradient(135deg, #555, #777)"
                        : "linear-gradient(135deg, #FF4081, #D81B60)",
                      boxShadow: disabled
                        ? "none"
                        : "0 3px 10px rgba(255,64,129,0.35)",
                    }}
                    data-testid={`redeem-${reward.ItemName.replace(/\s+/g, "-").toLowerCase()}`}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Gift className="h-3 w-3" />
                    )}
                    {!inStock
                      ? "Sold Out"
                      : !canAfford
                      ? "Need more"
                      : busy
                      ? "..."
                      : "Redeem"}
                  </motion.button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Redemption Timeline */}
      <div className="glass rounded-2xl p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#13C2C2]/15">
            <Clock className="h-4 w-4 text-[#13C2C2]" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Redemption History</h3>
            <p className="text-[10px] uppercase tracking-wider text-white/50">
              Items you have claimed
            </p>
          </div>
        </div>

        {parsedHistory.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-center text-xs text-white/50">
            Your redemption timeline will appear here.
          </p>
        ) : (
          <ol className="relative space-y-3 border-l-2 border-white/10 pl-5">
            {parsedHistory.map((h, i) => (
              <motion.li
                key={`${h.raw}-${i}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="relative"
              >
                <span
                  className="absolute -left-[27px] top-1 flex h-4 w-4 items-center justify-center rounded-full"
                  style={{
                    background: "linear-gradient(135deg, #13C2C2, #FFD85C)",
                    boxShadow: "0 0 8px rgba(19,194,194,0.6)",
                  }}
                >
                  <CheckCircle2 className="h-2.5 w-2.5 text-[#0B0520]" />
                </span>
                <div className="flex flex-col gap-0.5 rounded-lg border border-white/5 bg-black/25 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-semibold text-white">
                    {h.itemName}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
                    {h.date && <span>{h.date}</span>}
                    {h.points && (
                      <span className="rounded bg-[#FF4081]/15 px-1.5 py-0.5 font-bold text-[#FF4081]">
                        {h.points}
                      </span>
                    )}
                  </div>
                </div>
              </motion.li>
            ))}
          </ol>
        )}
      </div>

      {/* Gift code modal */}
      <AnimatePresence>
        {giftCode && (
          <motion.div
            key="giftcode"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[250] flex items-center justify-center bg-black/75 px-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.85, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.85, opacity: 0 }}
              className="glass-strong relative w-full max-w-md rounded-2xl p-6 text-center"
            >
              <button
                onClick={onCloseGiftCode}
                className="absolute right-3 top-3 rounded-full p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
              <div
                className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
                style={{
                  background: "linear-gradient(135deg, #FFD85C, #FF4081)",
                  boxShadow: "0 0 25px rgba(255,216,92,0.55)",
                }}
              >
                <Gift className="h-8 w-8 text-[#0B0520]" />
              </div>
              <h2 className="text-xl font-extrabold text-gradient-gold">
                Your Gift Code
              </h2>
              <p className="mt-2 text-xs text-white/60">
                Save this code — you'll need it to claim your reward.
              </p>
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-white/15 bg-black/40 px-4 py-3">
                <code className="text-base font-bold tracking-wider text-[#FFD85C]">
                  {giftCode}
                </code>
                <button
                  onClick={() => navigator.clipboard?.writeText(giftCode)}
                  className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-white/20"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={onCloseGiftCode}
                className="mt-5 w-full rounded-xl px-6 py-3 font-bold text-white shadow-[0_6px_20px_rgba(19,194,194,0.4)]"
                style={{
                  background: "linear-gradient(135deg, #13C2C2, #0D9488)",
                }}
              >
                Got it!
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
