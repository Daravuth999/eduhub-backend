/**
 * LatestRewardCard.tsx — My Portal Instant Persistent Cache v2
 * (premium Apple-glass Rewards box)
 *
 * Reads the authoritative Mongo ledger via /api/student/points/latest
 * (powered by `points_ledger_api.py`). It NEVER reads localStorage as
 * a source of truth — the legacy `rewardMemory` is no longer
 * consulted. The companion backend fix in `login_reward_tools.py`
 * ensures the Login Reward claim writes a confirmed
 * `points_transactions` row, so the box now reflects reality after a
 * +50 reward claim instead of showing "No confirmed reward yet".
 *
 * v2 -- Instant Persistent Loading
 *   On mount we synchronously read the most recent successful
 *   `RewardView` snapshot from `portalPersistentCache` (a
 *   localStorage-backed, student-scoped, TTL-bounded UI snapshot).
 *   Within the TTL window the card paints with the last-known
 *   reward immediately -- no shimmer flash on warm visits or PWA
 *   reopens. A real network refetch always runs in the background;
 *   if it succeeds the cache + UI update atomically, if it fails
 *   silently we keep the cached card on screen (cold-path failures
 *   still surface the honest "Reward history is briefly unavailable"
 *   state as before).
 *
 *   The cache is student-scoped and is wiped automatically on
 *   logout (see `portalPersistentCache.ts`).
 *
 * Four visual states, all premium glass on the dark navy theme:
 *
 *   1. Loading  – elegant shimmer
 *   2. Empty    – calm "no reward yet" state, still beautiful
 *   3. Success  – Apple-glass reward card with reward icon, source,
 *                 amount, relative time, and a soft confidence glow
 *                 on entry (respects `prefers-reduced-motion`).
 *   4. Error    – trustworthy "history temporarily unavailable" note
 *
 * Animation contract preserved (data-testid, data-tier, data-arriving)
 * so existing tests + sign-off keep working.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Gift, Minus, Sparkles, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkle } from "../primitives/Sparkle";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import {
  fetchLatestConfirmedCredit,
  ledgerRelativeTime,
  type LedgerTransaction,
} from "../../lib/transactionsApi";
import type { SpendDeltaEvent } from "../../hooks/usePoints";
import {
  cacheRead,
  cacheWrite,
  cacheInvalidate,
  PORTAL_CACHE_SECTIONS,
} from "../../lib/portalPersistentCache";

interface Props {
  /** Student id — kept for backwards-compatible call sites. */
  studentId: string;
  /** Bumps whenever a poll-driven event lands — triggers the entry animation. */
  rewardVersion: number;
  /** Latest spend event — used to neutralise a stale reward card. */
  spendEvent: SpendDeltaEvent | null;
  /** Optional explicit refresh key bumped by parent (P2P send, etc). */
  refreshKey?: number;
}

type Tier = "tiny" | "nice" | "big" | "huge";

interface RewardView {
  amount: number;
  ts: number;
  titleEn: string;
  titleKm: string;
  descriptionEn: string;
  descriptionKm: string;
  tier: Tier;
  source: string;
}

const NEUTRAL = {
  titleEn: "Balance adjusted",
  titleKm: "ការកែតម្រូវពិន្ទុ",
  subEn:   "Points were spent",
  subKm:   "ពិន្ទុត្រូវបានចំណាយ",
};

function tierFromAmount(amount: number): Tier {
  if (amount >= 100) return "huge";
  if (amount >= 25)  return "big";
  if (amount >= 5)   return "nice";
  return "tiny";
}

function fromTxn(tx: LedgerTransaction): RewardView {
  const tsRaw = tx.created_at ? Date.parse(tx.created_at) : NaN;
  const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now();
  return {
    amount:        tx.amount,
    ts,
    titleEn:       tx.title    || "Points activity",
    titleKm:       tx.title_km || tx.title || "សកម្មភាពពិន្ទុ",
    descriptionEn: tx.description || "",
    descriptionKm: tx.description || "",
    tier:          tierFromAmount(tx.amount),
    source:        tx.source,
  };
}

/**
 * Apple-glass surface tokens, scoped to this component so we don't
 * collide with anything else in the Portal. Used for all 4 states
 * so the box keeps a consistent silhouette as it transitions.
 */
const GLASS = {
  background:
    "linear-gradient(180deg, " +
    "color-mix(in oklab, var(--color-surface) 78%, transparent) 0%, " +
    "color-mix(in oklab, var(--color-surface-2) 86%, transparent) 100%)",
  border:
    "1px solid color-mix(in oklab, var(--color-line-strong) 70%, transparent)",
  boxShadow:
    "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 8%, transparent), " +
    "inset 0 -1px 0 rgba(0,0,0,0.25), " +
    "0 18px 40px -22px rgba(0,0,0,0.55), " +
    "0 2px 6px -2px rgba(0,0,0,0.35)",
  backdropFilter: "blur(18px) saturate(160%)",
  WebkitBackdropFilter: "blur(18px) saturate(160%)",
} as const;

export function LatestRewardCard({
  studentId: _studentId,
  rewardVersion,
  spendEvent,
  refreshKey = 0,
}: Props) {
  const { t, lang, num } = useLang();
  const reduced = useReducedMotion();

  // --- Cache-first synchronous hydration --------------------------------
  // The persisted `RewardView` snapshot lets the card paint instantly
  // on warm visits or PWA reopens within the TTL window. The
  // background refetch always runs to revalidate against the
  // authoritative Mongo ledger.
  const [cachedSnapshot] = useState<{ value: RewardView; freshness: "fresh" | "stale" } | null>(
    () => cacheRead<RewardView>(PORTAL_CACHE_SECTIONS.latestReward),
  );
  const [reward, setReward] = useState<RewardView | null>(
    cachedSnapshot ? cachedSnapshot.value : null,
  );
  // Cold start  -> loading=true (no cache, shimmer).
  // Warm start  -> loading=false (we already have a reward to show).
  const [loading, setLoading] = useState<boolean>(!cachedSnapshot);
  const [errored, setErrored] = useState<boolean>(false);
  const [arriving, setArriving] = useState(false);
  const [tick, setTick] = useState(0);
  const lastTsRef = useRef<number>(
    cachedSnapshot ? cachedSnapshot.value.ts : 0,
  );
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async (background: boolean) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (!background) setLoading(true);
    const res = await fetchLatestConfirmedCredit({ signal: ac.signal });
    if (ac.signal.aborted) return;
    if (!background) setLoading(false);
    if (res.ok === false) {
      // Surface the error state ONLY when we have nothing to show.
      // A background failure with cached data on screen stays silent
      // so a brief network blip never visually demotes the student's
      // confirmed reward.
      if (!reward) setErrored(true);
      return;
    }
    setErrored(false);
    const tx = res.data.transaction;
    if (!tx) {
      // Authoritative empty -- backend confirmed there is no
      // confirmed credit for this student. We must drop the
      // persistent cache entry too (not just the in-memory state),
      // otherwise an older cached reward would re-appear on the
      // next PWA reopen and disagree with backend truth.
      cacheInvalidate(PORTAL_CACHE_SECTIONS.latestReward);
      setReward(null);
      lastTsRef.current = 0;
      return;
    }
    const view = fromTxn(tx);
    if (view.ts > lastTsRef.current) {
      lastTsRef.current = view.ts;
      setArriving(true);
      window.setTimeout(() => setArriving(false), 1800);
    }
    setReward(view);
    cacheWrite<RewardView>(PORTAL_CACHE_SECTIONS.latestReward, view);
  }, [reward]);

  useEffect(() => {
    // First render: choose between a cold load (shimmer -> data) and
    // a warm revalidation (already painted from cache, fetch silently).
    // A "stale" hit still hydrates immediately but kicks a foreground
    // refetch so any change lands quickly.
    const hit = cachedSnapshot;
    if (!hit) {
      refetch(false);
    } else if (hit.freshness === "fresh") {
      refetch(true);
    } else {
      refetch(false);
    }
    return () => abortRef.current?.abort();
    // rewardVersion bumps on poll, refreshKey bumps from parent
    // (e.g. SendPointsModal close → balance change → bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewardVersion, refreshKey]);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const ago = useMemo(
    () =>
      reward
        ? ledgerRelativeTime(
            new Date(reward.ts).toISOString(),
            lang === "km" ? "km" : "en",
          )
        : "",
    [reward, lang],
  );

  // Neutralisation: SpendDeltaEvent carries no timestamp in this codebase
  // (matches the legacy card), so we simply mute the celebration whenever
  // an unconsumed debit is observed. The consumer clears the event right
  // after, so the card returns to celebratory mode on the next poll.
  const isNeutralised = useMemo(() => {
    if (!spendEvent) return false;
    if (!reward) return false;
    return true;
  }, [spendEvent, reward]);

  /* ─────────── LOADING — shimmer skeleton ─────────── */
  if (loading && !reward) {
    return (
      <div
        className="relative rounded-2xl overflow-hidden px-4 py-3.5"
        style={GLASS}
        data-testid="latest-reward-card-loading"
      >
        <div className="flex items-center gap-3">
          <div
            className="h-12 w-12 rounded-2xl"
            style={{
              background:
                "color-mix(in oklab, var(--color-ink-mute) 18%, transparent)",
            }}
          />
          <div className="flex-1 min-w-0 space-y-2">
            <div
              className="h-3 rounded"
              style={{
                width: "60%",
                background:
                  "color-mix(in oklab, var(--color-ink-mute) 18%, transparent)",
              }}
            />
            <div
              className="h-2.5 rounded"
              style={{
                width: "40%",
                background:
                  "color-mix(in oklab, var(--color-ink-mute) 14%, transparent)",
              }}
            />
          </div>
        </div>
        {!reduced && (
          <span
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.10) 50%, transparent 70%)",
              animation: "sweep 1.8s linear infinite",
            }}
          />
        )}
      </div>
    );
  }

  /* ─────────── ERROR — calm, not broken-feeling ─────────── */
  if (errored && !reward) {
    return (
      <div
        className="relative rounded-2xl overflow-hidden px-4 py-3.5"
        style={GLASS}
        data-testid="latest-reward-card-error"
      >
        <div className="flex items-center gap-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center"
            style={{
              background:
                "color-mix(in oklab, var(--color-accent-warm) 14%, transparent)",
              color: "var(--color-accent-warm)",
            }}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {t("rewardsLabel")}
            </div>
            <div
              className="text-sm leading-snug"
              style={{ color: "var(--color-ink-soft)" }}
            >
              {lang === "km"
                ? "ប្រវត្តិរង្វាន់មិនអាចបង្ហាញបាននៅពេលនេះ។ ពិន្ទុរបស់អ្នកនៅតែត្រូវបានការពារ។"
                : "Reward history is briefly unavailable. Your balance is still protected."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ─────────── EMPTY — premium, not disappointing ─────────── */
  if (!reward) {
    return (
      <div
        className="relative rounded-2xl overflow-hidden px-4 py-3.5"
        style={GLASS}
        data-testid="latest-reward-card-empty"
      >
        <div className="flex items-center gap-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in oklab, var(--color-accent-warm) 26%, transparent), color-mix(in oklab, var(--color-good) 22%, transparent))",
              color: "var(--color-ink)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.20), 0 6px 16px -8px color-mix(in oklab, var(--color-accent-warm) 50%, transparent)",
            }}
          >
            <Gift className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {t("rewardsLabel")}
            </div>
            <div
              className="display text-base font-semibold leading-tight"
              style={{ color: "var(--color-ink)" }}
            >
              {lang === "km"
                ? "រង្វាន់បន្ទាប់នឹងលេចឡើងនៅទីនេះ"
                : "Your next reward will appear here"}
            </div>
            <div
              className="text-[11px] mt-0.5"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {lang === "km"
                ? "ការទទួលរង្វាន់ ការដាក់ពិន្ទុ និងពិន្ទុដែលអ្នកទទួលនឹងបង្ហាញ"
                : "Top-ups, daily rewards, and gifts will land here"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ─────────── NEUTRALISED — debit observed, mute the celebration ─────────── */
  if (isNeutralised) {
    return (
      <motion.div
        key="neutralised"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0.72 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative rounded-2xl overflow-hidden"
        data-testid="latest-reward-card-neutralised"
        data-tier={reward.tier}
        style={GLASS}
      >
        <div className="relative flex items-center gap-3 px-4 py-3.5">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0"
            style={{
              background:
                "color-mix(in oklab, var(--color-ink-mute) 16%, transparent)",
              color: "var(--color-ink-mute)",
            }}
          >
            <Minus className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="display text-base font-semibold leading-tight"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {lang === "km" ? NEUTRAL.titleKm : NEUTRAL.titleEn}
            </div>
            <div
              className="text-xs mt-0.5"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {lang === "km" ? NEUTRAL.subKm : NEUTRAL.subEn}
            </div>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-[2px]"
          style={{ background: "var(--color-line)" }}
        />
      </motion.div>
    );
  }

  /* ─────────── SUCCESS — Apple-glass with confidence glow ─────────── */
  const titleText = lang === "km" ? reward.titleKm : reward.titleEn;
  const descText  = lang === "km" ? reward.descriptionKm : reward.descriptionEn;
  // Two accents traded depending on `arriving` so the entry animation
  // has a soft hue shift without the colours feeling random.
  const accentA = arriving ? "var(--color-good)"        : "var(--color-accent-warm)";
  const accentB = arriving ? "var(--color-accent-warm)" : "var(--color-good)";

  return (
    <motion.div
      initial={false}
      animate={arriving && !reduced ? { scale: [1, 1.04, 1] } : { scale: 1 }}
      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-2xl overflow-hidden"
      data-testid="latest-reward-card"
      data-tier={reward.tier}
      data-arriving={arriving}
      data-source={reward.source}
      style={{
        ...GLASS,
        border:
          "1px solid color-mix(in oklab, var(--color-good) 35%, color-mix(in oklab, var(--color-line-strong) 70%, transparent))",
      }}
    >
      {/* Soft conic accent glow — barely there, premium not loud. */}
      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          animate={{ rotate: 360 }}
          transition={{
            repeat: Infinity,
            duration: arriving ? 8 : 36,
            ease: "linear",
          }}
          style={{
            background:
              `conic-gradient(from 0deg, ${accentA}10, ${accentB}24, ${accentA}10, transparent 55%, ${accentB}1a, ${accentA}10)`,
            mixBlendMode: "soft-light",
            opacity: arriving ? 0.85 : 0.55,
          }}
        />
      )}

      {/* Top inner highlight — the "lit-from-above" glass cue. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-2xl"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0))",
        }}
      />

      {/* Arrival shimmer streak (one-shot when a fresh reward lands). */}
      <AnimatePresence>
        {arriving && !reduced && (
          <motion.span
            key="shimmer"
            aria-hidden
            className="absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none"
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: ["0%", "320%"], opacity: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.4, ease: "linear" }}
            style={{
              background:
                "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)",
            }}
          />
        )}
      </AnimatePresence>

      {/* Confidence sparkles — only on arrival, never persistent. */}
      <AnimatePresence>
        {arriving && !reduced && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden>
            {Array.from({ length: 10 }).map((_, i) => {
              const a = (i / 10) * Math.PI * 2;
              const dist = 86 + (i % 3) * 14;
              return (
                <motion.span
                  key={i}
                  className="absolute top-1/2 left-1/2"
                  initial={{ x: 0, y: 0, opacity: 0, scale: 0.35 }}
                  animate={{
                    x: Math.cos(a) * dist,
                    y: Math.sin(a) * dist,
                    opacity: [0, 1, 1, 0],
                    scale: [0.35, 1, 1, 0.55],
                    rotate: [0, 180, 360],
                  }}
                  transition={{ duration: 1.4, delay: i * 0.04 }}
                  style={{ color: accentA }}
                >
                  <Sparkle size={9 + (i % 3) * 3} color="currentColor" />
                </motion.span>
              );
            })}
          </div>
        )}
      </AnimatePresence>

      <div className="relative flex items-center gap-3 px-4 py-3.5">
        {/* Reward icon — glass-coin treatment with subtle inner ring. */}
        <motion.div
          className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 relative overflow-hidden"
          animate={
            arriving && !reduced
              ? { rotate: [0, -8, 8, -4, 0], scale: [1, 1.12, 1] }
              : { rotate: 0, scale: 1 }
          }
          transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
          style={{
            background: `linear-gradient(135deg, ${accentA}, ${accentB})`,
            color: "#1a1d29",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.45), " +
              "inset 0 -1px 0 rgba(0,0,0,0.18), " +
              "0 10px 24px -10px color-mix(in oklab, var(--color-good) 60%, transparent)",
          }}
        >
          {/* Inner gloss strip — visible only on the upper portion. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0))",
            }}
          />
          <Gift className="h-5 w-5 relative" />
        </motion.div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <motion.span
              className="display tnum text-2xl sm:text-[26px] font-bold leading-none"
              style={{ color: "var(--color-good)" }}
              animate={
                arriving && !reduced
                  ? {
                      textShadow: [
                        "0 0 0 rgba(0,0,0,0)",
                        "0 0 22px color-mix(in oklab, var(--color-good) 70%, transparent)",
                        "0 0 0 rgba(0,0,0,0)",
                      ],
                    }
                  : {}
              }
              transition={{ duration: 1.2 }}
            >
              +
              <AnimatedNumber value={reward.amount} duration={1100} localise />
              <span className="hidden">{num(reward.amount)}</span>
            </motion.span>
            <span
              className="text-[10px] font-bold uppercase tracking-[0.22em] px-2 py-0.5 rounded-full"
              style={{
                background:
                  "color-mix(in oklab, var(--color-good) 18%, transparent)",
                color: "var(--color-good)",
                border:
                  "1px solid color-mix(in oklab, var(--color-good) 30%, transparent)",
              }}
            >
              {t("rewardsLabel")}
            </span>
          </div>
          <div className="mt-1 min-w-0">
            <div
              className="text-xs font-semibold truncate"
              style={{ color: "var(--color-ink)" }}
            >
              {titleText}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
              <Sparkles
                className="h-3 w-3 shrink-0"
                style={{ color: accentB }}
              />
              <span
                className="text-[11px] truncate"
                style={{ color: "var(--color-ink-soft)" }}
              >
                {descText ||
                  (lang === "km"
                    ? "ទទួលបានជោគជ័យ"
                    : "Received successfully")}
              </span>
              <span
                className="text-[11px] mono ml-auto pl-2 shrink-0"
                style={{ color: "var(--color-ink-mute)" }}
              >
                {ago}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom accent rail — premium gradient seam. */}
      <div
        aria-hidden
        className="absolute left-0 right-0 bottom-0 h-[3px]"
        style={{
          background: `linear-gradient(90deg, ${accentA}, ${accentB}, ${accentA})`,
          opacity: 0.9,
        }}
      />
      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute bottom-0 left-0 h-[3px] w-1/3"
          animate={{ x: ["-100%", "300%"] }}
          transition={{
            repeat: Infinity,
            duration: arriving ? 1.8 : 5.6,
            ease: "linear",
          }}
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)",
          }}
        />
      )}
    </motion.div>
  );
}
