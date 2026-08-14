/**
 * TransactionTimeline.tsx — My Portal Instant Persistent Cache v2
 *
 * Renders the calling student's authoritative MongoDB points ledger as
 * a touch-friendly, premium dark timeline under My Portal. Reads from
 * the corrected /api/student/points/transactions endpoint via
 * transactionsApi.ts.
 *
 * Honesty contract:
 *  • Credits render with a green "+N" pill.
 *  • Debits  render with a warm "-N" pill.
 *  • Source label + a one-line, student-friendly description.
 *    Raw wallet ids, idempotency keys, and the word "shadow" never
 *    reach this component.
 *  • Status badge appears ONLY when status !== "confirmed".
 *  • Loading skeleton, honest empty state, error fallback, manual refresh.
 *  • Re-fetches on `refreshKey` change (parent bumps after a P2P send
 *    success, balance change, or coupon redeem).
 *
 * v2 -- Instant Persistent Loading
 *   On mount we synchronously read the last successful list of rows
 *   from `portalPersistentCache` (a localStorage-backed,
 *   student-scoped, TTL-bounded snapshot). Within the TTL window the
 *   timeline paints with the cached rows immediately -- no skeleton
 *   flash on warm visits or PWA reopens. A real network refetch
 *   always runs in the background to revalidate. On a background
 *   failure we keep the cached rows on screen (cold-path failures
 *   still surface the honest "temporarily unavailable" fallback).
 *
 *   The cache is student-scoped and is wiped automatically on
 *   logout (see `portalPersistentCache.ts`).
 *
 * Pure display layer — no business logic, no balance math.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Book,
  Coins,
  Gift,
  Loader2,
  RefreshCw,
  Sparkles,
  Users,
  ShieldCheck,
} from "lucide-react";
import { Card } from "../primitives/Card";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import {
  fetchStudentTransactions,
  ledgerRelativeTime,
  type LedgerTransaction,
} from "../../lib/transactionsApi";
import {
  cacheRead,
  cacheWrite,
  PORTAL_CACHE_SECTIONS,
} from "../../lib/portalPersistentCache";

interface Props {
  /** Bumped by parent on P2P send / coupon redeem / top-up to force refresh. */
  refreshKey?: number;
  /** Max rows to display in the collapsed timeline. */
  initialLimit?: number;
}

type LoadState = "idle" | "loading" | "ok" | "error";

const SOURCE_ICON: Record<string, ReactElement> = {
  payment_bridge:        <Coins className="h-4 w-4" />,
  payment:               <Coins className="h-4 w-4" />,
  topup:                 <Coins className="h-4 w-4" />,
  khqr:                  <Coins className="h-4 w-4" />,
  camrapidpay:           <Coins className="h-4 w-4" />,
  login_reward:          <Gift className="h-4 w-4" />,
  login_reward_campaign: <Gift className="h-4 w-4" />,
  login_campaign:        <Gift className="h-4 w-4" />,
  daily_reward:          <Gift className="h-4 w-4" />,
  referral_reward:       <Users className="h-4 w-4" />,
  referral_bonus:        <Users className="h-4 w-4" />,
  referral:              <Users className="h-4 w-4" />,
  book_unlock:           <Book className="h-4 w-4" />,
  unlock_book:           <Book className="h-4 w-4" />,
  library_purchase:      <Book className="h-4 w-4" />,
  library:               <Book className="h-4 w-4" />,
  book_purchase:         <Book className="h-4 w-4" />,
  p2p_send:              <ArrowUpRight className="h-4 w-4" />,
  p2p_receive:           <ArrowDownLeft className="h-4 w-4" />,
  p2p:                   <Users className="h-4 w-4" />,
  transfer:              <Users className="h-4 w-4" />,
  premium_ai:            <Sparkles className="h-4 w-4" />,
  executive_upgrade:     <Sparkles className="h-4 w-4" />,
  reader_ai:             <Sparkles className="h-4 w-4" />,
  ai_reader:             <Sparkles className="h-4 w-4" />,
  edutalk:               <Sparkles className="h-4 w-4" />,
  edutalk_voice:         <Sparkles className="h-4 w-4" />,
  edutalk_support:       <Sparkles className="h-4 w-4" />,
  ai_assistant_reward:   <Sparkles className="h-4 w-4" />,
  speech_mission:        <Sparkles className="h-4 w-4" />,
  speech_coach:          <Sparkles className="h-4 w-4" />,
  admin_adjustment:      <ShieldCheck className="h-4 w-4" />,
  teacher_adjustment:    <ShieldCheck className="h-4 w-4" />,
};

function iconForSource(source: string, direction: "credit" | "debit") {
  if (SOURCE_ICON[source]) return SOURCE_ICON[source];
  return direction === "debit" ? (
    <ArrowUpRight className="h-4 w-4" />
  ) : (
    <ArrowDownLeft className="h-4 w-4" />
  );
}

/** Friendly badge label for non-confirmed rows. Never displays the
 *  raw "shadow" word to students — see VALIDATION_REPORT.md.        */
function friendlyStatus(status: string, lang: "en" | "km"): string {
  if (lang === "km") {
    if (status === "pending") return "កំពុងរង់ចាំ";
    if (status === "failed") return "បរាជ័យ";
    if (status === "shadow") return "កំពុងផ្ទៀងផ្ទាត់";
    return status;
  }
  if (status === "pending") return "Pending";
  if (status === "failed") return "Failed";
  if (status === "shadow") return "Pending verification";
  return status;
}

export function TransactionTimeline({
  refreshKey = 0,
  initialLimit = 8,
}: Props) {
  const { lang } = useLang();
  const reduced = useReducedMotion();

  // --- Cache-first synchronous hydration --------------------------------
  // Persisted rows let the timeline paint instantly on warm visits or
  // PWA reopens within the TTL window. The background refetch always
  // runs to revalidate against the authoritative Mongo ledger.
  const [cachedSnapshot] = useState<{ value: LedgerTransaction[]; freshness: "fresh" | "stale" } | null>(
    () => cacheRead<LedgerTransaction[]>(PORTAL_CACHE_SECTIONS.transactions),
  );
  const [state, setState] = useState<LoadState>(
    cachedSnapshot ? "ok" : "idle",
  );
  const [rows, setRows] = useState<LedgerTransaction[]>(
    cachedSnapshot ? cachedSnapshot.value : [],
  );
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const [tick, setTick] = useState(0); // forces relative-time re-render
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async (background: boolean = false) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // For background revalidation we keep the current `state` (which
    // is "ok" when we painted from cache) so the row list stays on
    // screen without a skeleton flash.
    if (!background) setState("loading");
    setErrorMsg("");
    const result = await fetchStudentTransactions({
      limit: 50,
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    if (result.ok === false) {
      // "aborted" is a normal cancel — don't surface it as an error to the UI.
      if (result.message === "aborted") return;
      // Background revalidation failures with cached rows on screen
      // MUST NOT clobber the UI. Only the cold path surfaces the
      // honest "temporarily unavailable" fallback.
      if (background && rows.length > 0) return;
      setState("error");
      setErrorMsg(result.message);
      return;
    }
    setRows(result.data.transactions);
    // Cache only the small list of rows we render. Backend stays
    // the source of truth for status / amounts on the next mount.
    cacheWrite<LedgerTransaction[]>(
      PORTAL_CACHE_SECTIONS.transactions,
      result.data.transactions,
    );
    setState("ok");
  }, [rows.length]);

  useEffect(() => {
    // First render: choose between cold (skeleton -> data) and warm
    // (already painted from cache, fetch silently). A "stale" hit
    // still hydrates immediately but kicks a foreground refetch.
    const hit = cachedSnapshot;
    if (!hit) {
      fetchOnce(false);
    } else if (hit.freshness === "fresh") {
      fetchOnce(true);
    } else {
      fetchOnce(true); // stale -> still background; UI already has rows
    }
    return () => abortRef.current?.abort();
    // We intentionally re-run on every refreshKey bump so parent-
    // driven invalidations (P2P send, coupon redeem, top-up) reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Re-render relative timestamps every minute.
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(
    () => (expanded ? rows : rows.slice(0, initialLimit)),
    [rows, expanded, initialLimit],
  );

  const isEn = lang !== "km";
  const heading = isEn ? "Transaction history" : "ប្រវត្តិពិន្ទុ";
  const refreshLabel = isEn ? "Refresh" : "ផ្ទុកឡើងវិញ";
  const seeMoreLabel = isEn ? "Show more" : "មើលបន្ថែម";
  const collapseLabel = isEn ? "Show less" : "បង្រួម";
  const sourceTooltip = isEn
    ? "Backed by your MongoDB points ledger"
    : "ផ្អែកលើបញ្ជីពិន្ទុ MongoDB";
  // tick is intentionally referenced indirectly so React re-renders the
  // relative time strings without extra state churn.
  void tick;

  return (
    <Card
      data-testid="transaction-timeline"
      className="relative overflow-hidden"
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className="text-sm font-semibold tracking-wide uppercase truncate"
            style={{ color: "var(--color-ink-soft)" }}
            title={sourceTooltip}
          >
            {heading}
          </h3>
          {state === "loading" && rows.length > 0 && (
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
          )}
        </div>
        <button
          type="button"
          onClick={() => fetchOnce(false)}
          disabled={state === "loading"}
          data-testid="transaction-timeline-refresh"
          aria-label={refreshLabel}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition shrink-0"
          style={{
            background: "color-mix(in oklab, var(--color-good) 12%, transparent)",
            color: "var(--color-good)",
            border: "1px solid color-mix(in oklab, var(--color-good) 32%, transparent)",
            opacity: state === "loading" ? 0.55 : 1,
          }}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin" : ""}`}
          />
          {refreshLabel}
        </button>
      </div>

      {/* LOADING (first paint, no cached rows) ─────────────────────────── */}
      {state === "loading" && rows.length === 0 && (
        <div
          data-testid="transaction-timeline-loading"
          className="flex flex-col gap-2"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-xl animate-pulse"
              style={{
                background: "color-mix(in oklab, var(--color-ink-mute) 12%, transparent)",
              }}
            />
          ))}
        </div>
      )}

      {/* ERROR ─────────────────────────────────────────────────────────── */}
      {state === "error" && rows.length === 0 && (
        <div
          data-testid="transaction-timeline-error"
          className="rounded-xl px-3 py-3 text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-warm) 8%, transparent)",
            border: "1px dashed color-mix(in oklab, var(--color-warm) 32%, transparent)",
            color: "var(--color-ink-soft)",
          }}
        >
          {isEn
            ? "Transaction history is temporarily unavailable. Your balance is still protected."
            : "ប្រវត្តិពិន្ទុមិនអាចបង្ហាញបាននៅពេលនេះ។ ពិន្ទុរបស់អ្នកនៅតែត្រូវបានការពារ។"}
          <div className="mt-2 text-[11px] opacity-60">{errorMsg}</div>
        </div>
      )}

      {/* EMPTY ─────────────────────────────────────────────────────────── */}
      {state === "ok" && rows.length === 0 && (
        <div
          data-testid="transaction-timeline-empty"
          className="rounded-xl px-3 py-5 text-sm text-center"
          style={{
            background: "var(--color-surface-2)",
            border: "1px dashed var(--color-line-strong)",
            color: "var(--color-ink-mute)",
          }}
        >
          <div
            className="display text-base font-semibold mb-1"
            style={{ color: "var(--color-ink-soft)" }}
          >
            {isEn ? "No confirmed activity yet" : "មិនទាន់មានសកម្មភាពនៅឡើយ"}
          </div>
          <div className="text-[12px] leading-relaxed">
            {isEn
              ? "Top-ups, rewards, and points you send or receive will appear here."
              : "ការបញ្ចូលពិន្ទុ រង្វាន់ និងពិន្ទុដែលអ្នកផ្ញើ ឬទទួល នឹងបង្ហាញនៅទីនេះ។"}
          </div>
        </div>
      )}

      {/* ROWS ──────────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <ul
          data-testid="transaction-timeline-list"
          className="flex flex-col gap-2"
        >
          <AnimatePresence initial={false}>
            {visible.map((row, idx) => {
              const isCredit = row.direction === "credit";
              const sign = isCredit ? "+" : "−";
              const amountColor = isCredit
                ? "var(--color-good)"
                : "var(--color-warm)";
              const iconBg = isCredit
                ? "color-mix(in oklab, var(--color-good) 14%, transparent)"
                : "color-mix(in oklab, var(--color-warm) 14%, transparent)";
              const displayTitle =
                lang === "km" && row.title_km ? row.title_km : row.title;
              const descriptionParts: string[] = [];
              if (row.description) descriptionParts.push(row.description);
              const rel = ledgerRelativeTime(row.created_at, isEn ? "en" : "km");
              if (rel) descriptionParts.push(rel);
              const isPending = row.status && row.status !== "confirmed";
              return (
                <motion.li
                  key={row.id || `${row.created_at}-${idx}`}
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: isPending ? 0.85 : 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.22 }}
                  data-testid={`txn-row-${row.id || idx}`}
                  data-direction={row.direction}
                  data-status={row.status}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-line)",
                  }}
                >
                  <div
                    className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: iconBg, color: amountColor }}
                  >
                    {iconForSource(row.source, row.direction)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="text-sm font-semibold truncate"
                        style={{ color: "var(--color-ink)" }}
                      >
                        {displayTitle}
                      </span>
                      {isPending && (
                        <span
                          className="text-[9px] uppercase tracking-wider px-1.5 py-[2px] rounded-full font-bold shrink-0"
                          style={{
                            background:
                              row.status === "failed"
                                ? "color-mix(in oklab, var(--color-warm) 18%, transparent)"
                                : "color-mix(in oklab, var(--color-ink-mute) 16%, transparent)",
                            color:
                              row.status === "failed"
                                ? "var(--color-warm)"
                                : "var(--color-ink-mute)",
                          }}
                          data-testid={`txn-status-${row.status}`}
                        >
                          {friendlyStatus(row.status, isEn ? "en" : "km")}
                        </span>
                      )}
                    </div>
                    {descriptionParts.length > 0 && (
                      <div
                        className="text-[11px] truncate mt-0.5"
                        style={{ color: "var(--color-ink-mute)" }}
                      >
                        {descriptionParts.join(" · ")}
                      </div>
                    )}
                  </div>
                  <div
                    className="text-sm font-bold tabular-nums shrink-0"
                    style={{ color: amountColor }}
                    data-testid={`txn-amount-${row.id || idx}`}
                  >
                    {sign}
                    {row.amount}
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      {/* Expand / collapse ─────────────────────────────────────────────── */}
      {rows.length > initialLimit && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="transaction-timeline-toggle"
          className="mt-3 w-full text-xs font-semibold py-2 rounded-xl transition"
          style={{
            color: "var(--color-good)",
            background: "color-mix(in oklab, var(--color-good) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--color-good) 24%, transparent)",
          }}
        >
          {expanded ? collapseLabel : `${seeMoreLabel} (${rows.length - initialLimit})`}
        </button>
      )}
    </Card>
  );
}
