/**
 * ReferralBonusCard.jsx -- My Portal Instant Persistent Cache v2.
 *
 * Premium, compact referral reward card.
 *
 * EduHub Lumio (2026): repaletted to the unified light "Aurora" reward
 * palette (cream surface + coral accent) so the Rewards & Vouchers +
 * Referral surfaces read as one premium reward block. Data flow, the
 * cache-first hydration, the self-hide / paused contracts, copy/share
 * behaviour, and every value are preserved verbatim — only presentation
 * changed.
 *
 * HONESTY CONTRACT
 *   - All values are sourced from GET /api/referral/stats. No fake
 *     stats. No localStorage referral truth.
 *   - If the backend returned `show_card === false` -> render nothing.
 *   - If `enabled === false` -> render a calm "paused" tile.
 *   - If the GET failed -> render nothing (silent).
 *   - Loading -> skeleton tile, no fabricated numbers.
 *
 * ZERO backend logic was touched in this patch.
 */
import { useEffect, useState } from "react";
import { Copy, Share2, Users, Gift, Sparkles, ChevronRight } from "lucide-react";
import { getReferralStats, safeRead } from "../lib/referralApi";
import {
  cacheRead,
  cacheWrite,
  PORTAL_CACHE_SECTIONS,
} from "../pages/portal/lib/portalPersistentCache";

const ACCENT = "var(--color-accent-warm)";

export default function ReferralBonusCard() {
  // --- Cache-first synchronous hydration --------------------------------
  const [cachedSnapshot] = useState(() =>
    cacheRead(PORTAL_CACHE_SECTIONS.referral) || null,
  );
  const [stats, setStats] = useState(cachedSnapshot ? cachedSnapshot.value : null);
  const [loading, setLoading] = useState(!cachedSnapshot);
  const [copied, setCopied] = useState(false);
  const [shareErr, setShareErr] = useState("");

  useEffect(() => {
    let alive = true;
    const hadCache = !!cachedSnapshot;
    (async () => {
      if (!hadCache) setLoading(true);
      const data = await safeRead(getReferralStats, null);
      if (!alive) return;
      if (data) {
        setStats(data);
        cacheWrite(PORTAL_CACHE_SECTIONS.referral, data);
      } else if (!hadCache) {
        setStats(null);
      }
      if (!hadCache) setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- Loading -- premium skeleton, no fake numbers. --------
  if (loading) {
    return (
      <section
        data-testid="referral-bonus-card-loading"
        data-accent="coral"
        className="lumio-surface lumio-surface--strip p-5"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="aurora-icon-badge h-7 w-7" data-accent="coral">
            <Gift className="h-3.5 w-3.5" />
          </span>
          <div
            className="h-3 w-28 animate-pulse rounded-full"
            style={{ background: "var(--color-surface-2)" }}
          />
        </div>
        <div
          className="mb-2 h-4 w-3/4 animate-pulse rounded-full"
          style={{ background: "var(--color-surface-2)" }}
        />
        <div
          className="h-3 w-2/4 animate-pulse rounded-full"
          style={{ background: "var(--color-surface-2)" }}
        />
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-xl border"
              style={{
                background: "var(--color-surface-2)",
                borderColor: "var(--color-line)",
              }}
            />
          ))}
        </div>
      </section>
    );
  }

  // -------- Backend silent failure -- self-hide (unchanged contract). --------
  if (!stats) return null;

  // -------- Admin hide-card switch -- self-hide (unchanged contract). --------
  if (stats.show_card === false) return null;

  // -------- Admin pause state -- calm informative tile. --------
  if (stats.enabled === false) {
    return (
      <section
        data-testid="referral-bonus-card-paused"
        data-accent="coral"
        className="lumio-surface lumio-surface--strip p-5"
        style={{ color: "var(--color-ink)" }}
      >
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-ink-mute)]">
          <Gift className="h-3.5 w-3.5" /> Referral Bonus
        </div>
        <p className="text-[13px] leading-relaxed text-[color:var(--color-ink-soft)]">
          Referral rewards are currently paused. Check back soon.
        </p>
      </section>
    );
  }

  // -------- Real data (Mongo-backed). --------
  const rewardPts = Number(stats.reward_points || 0);
  const minPay = Number(stats.minimum_payment_usd || 0);
  const monthlyUsed = Number(stats.monthly_used || 0);
  const monthlyCap = Number(stats.monthly_cap || 0);
  const pending = Number(stats.pending_count || 0);
  const qualified = Number(stats.qualified_count || 0);
  const totalPts = Number(stats.total_points || 0);
  const shareUrl = stats.share_url || "";
  const refCode = stats.code || "";

  const onCopy = async () => {
    setShareErr("");
    if (!shareUrl) {
      setShareErr("No share link available yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setShareErr("Copy failed -- long-press the link instead.");
    }
  };

  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const onShare = async () => {
    setShareErr("");
    try {
      await navigator.share({
        title: "EduHub",
        text: refCode
          ? `Join me on EduHub. Use code ${refCode}.`
          : "Join me on EduHub.",
        url: shareUrl,
      });
    } catch {
      /* user cancelled -- silent */
    }
  };

  return (
    <section
      data-testid="referral-bonus-card"
      data-accent="coral"
      className="lumio-surface lumio-surface--strip relative overflow-hidden p-5 sm:p-6"
      style={{ color: "var(--color-ink)" }}
    >
      {/* Decorative coral glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full opacity-20"
        style={{
          background:
            "radial-gradient(circle, var(--color-accent-warm) 0%, transparent 70%)",
        }}
      />

      {/* Eyebrow */}
      <div className="relative mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-ink-mute)]">
        <span className="aurora-icon-badge h-6 w-6" data-accent="coral">
          <Gift className="h-3 w-3" />
        </span>
        Referral Bonus
      </div>

      {/* Headline + reward callout */}
      <h3 className="display relative mb-1 text-[18px] font-bold leading-snug sm:text-[20px] text-[color:var(--color-ink)]">
        {stats.display_message || "Invite friends. Earn points."}
      </h3>
      <p className="relative mb-4 text-[12.5px] text-[color:var(--color-ink-soft)]">
        <Sparkles className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]" style={{ color: ACCENT }} />
        Earn{" "}
        <span className="font-bold" style={{ color: ACCENT }}>
          {rewardPts} PTS
        </span>{" "}
        per eligible friend.
      </p>

      {/* Share / code row */}
      {(shareUrl || refCode) && (
        <div
          className="relative mb-4 flex items-center gap-2 rounded-xl border px-3 py-2"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-line-strong)",
          }}
          data-testid="referral-link-row"
        >
          <span
            className="flex-1 truncate font-mono text-[12px] text-[color:var(--color-ink-soft)]"
            title={shareUrl || refCode}
          >
            {shareUrl || refCode}
          </span>
          <button
            type="button"
            onClick={onCopy}
            data-testid="referral-copy-btn"
            className="lumio-focus eduhub-tap inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
            style={{
              background: copied
                ? "color-mix(in oklab, var(--color-excellent) 16%, transparent)"
                : "color-mix(in oklab, var(--color-accent-warm) 14%, transparent)",
              borderColor: copied
                ? "color-mix(in oklab, var(--color-excellent) 40%, transparent)"
                : "color-mix(in oklab, var(--color-accent-warm) 40%, transparent)",
              color: copied ? "var(--color-excellent)" : "var(--color-accent-warm)",
            }}
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy"}
          </button>
          {canShare && shareUrl && (
            <button
              type="button"
              onClick={onShare}
              data-testid="referral-share-btn"
              className="lumio-focus eduhub-tap inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 14%, transparent)",
                borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              <Share2 className="h-3 w-3" /> Share
            </button>
          )}
        </div>
      )}

      {/* Stats row */}
      <div className="relative mb-4 grid grid-cols-3 gap-2">
        <Stat label="Invited" value={pending + qualified} testid="referral-stat-pending" />
        <Stat label="Eligible" value={qualified} testid="referral-stat-qualified" />
        <Stat label="PTS Earned" value={totalPts} testid="referral-stat-total" />
      </div>

      {/* Monthly cap progress */}
      {monthlyCap > 0 && (
        <div className="relative mb-3" data-testid="referral-monthly-progress">
          <div className="mb-1 flex items-center justify-between text-[11px] text-[color:var(--color-ink-soft)]">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" /> Monthly cap
            </span>
            <span>
              {monthlyUsed} / {monthlyCap}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: "var(--color-surface-2)" }}
          >
            <div
              className="h-full"
              style={{
                width: `${Math.min(
                  100,
                  Math.round((monthlyUsed / monthlyCap) * 100),
                )}%`,
                background: "var(--gradient-coral)",
              }}
            />
          </div>
        </div>
      )}

      <p className="relative text-[11px] leading-relaxed text-[color:var(--color-ink-mute)]">
        {stats.terms_message ||
          `Reward is credited after your invited friend joins class or buys at least $${minPay.toFixed(
            2,
          )} in points.`}
      </p>
      {shareErr && (
        <p
          className="relative mt-2 text-[11px]"
          style={{ color: "var(--color-needs)" }}
          data-testid="referral-share-error"
        >
          {shareErr}
        </p>
      )}

      {/* Tiny call-out CTA */}
      {shareUrl && (
        <button
          type="button"
          onClick={canShare ? onShare : onCopy}
          data-testid="referral-cta-btn"
          className="lumio-focus eduhub-tap relative mt-4 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider"
          style={{
            background: ACCENT,
            color: "#fff",
          }}
        >
          {canShare ? "Share invite" : "Copy invite link"}
          <ChevronRight className="h-3 w-3" />
        </button>
      )}
    </section>
  );
}

function Stat({ label, value, testid }) {
  return (
    <div
      className="rounded-xl border px-2.5 py-2 text-center"
      style={{
        background: "var(--color-surface-2)",
        borderColor: "var(--color-line)",
      }}
      data-testid={testid}
    >
      <div className="display mb-0.5 text-[18px] font-bold leading-none text-[color:var(--color-ink)]">
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-mute)]">
        {label}
      </div>
    </div>
  );
}
