import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import type { CriterionKey, StudentData } from "../types";
import { extractScores, overallScore } from "../lib/scoring";
import { PortalAppBar } from "../components/layout/PortalAppBar";
import { AuroraBackdrop } from "../components/layout/AuroraBackdrop";
import { PageShell } from "../components/layout/PageShell";
import { ConnectionBanner } from "../components/layout/ConnectionBanner";
import { StudentHero } from "../components/dashboard/StudentHero";
import { MonthlyPerformance } from "../components/dashboard/MonthlyPerformance";
// Phase 5 v1.0.2 -- Mongo Points Ledger SoT: authoritative transaction timeline.
import { TransactionTimeline } from "../components/dashboard/TransactionTimeline";
import { CriteriaShelf } from "../components/dashboard/CriteriaShelf";
import { OverallScore } from "../components/dashboard/OverallScore";
import { FeedbackTriad } from "../components/dashboard/FeedbackTriad";
import { CommentsSection } from "../components/dashboard/CommentsSection";
import { PerformanceChart } from "../components/dashboard/PerformanceChart";
import { TopPerformerToast } from "../components/dashboard/TopPerformerToast";
import { CriterionDetailDrawer } from "../components/dashboard/CriterionDetailDrawer";
import { DebugDrawer } from "../components/dashboard/DebugDrawer";
import { ScoreGuideModal } from "../components/modals/ScoreGuideModal";
import { SendPointsModal } from "../components/modals/SendPointsModal";
import { RestrictionModal } from "../components/modals/RestrictionModal";
import { PointsTopUpPopup } from "../components/dashboard/PointsTopUpPopup";
// My Portal Premium Reconstruction v1 -- new groupings + glance card.
import { TuitionStrip } from "../components/dashboard/TuitionStrip";
import { QuickActionsShelf } from "../components/dashboard/QuickActionsShelf";
import PointsPurchaseModal from "../components/dashboard/PointsPurchaseModal";
import { MonthlyReviewExpander } from "../components/dashboard/MonthlyReviewExpander";
import { PerformanceGlance } from "../components/dashboard/PerformanceGlance";
import { RewardsHub } from "../components/dashboard/RewardsHub";
import SpeakingLabLiveCard from "../components/SpeakingLabLiveCard";
import { PrizePoolCardBoundary } from "../components/dashboard/PrizePoolCardBoundary";
import { useStudentData } from "../hooks/useStudentData";
import { useComments } from "../hooks/useComments";
import { useHistory } from "../hooks/useHistory";
import { usePoints } from "../hooks/usePoints";
import { useIdleLogout } from "../hooks/useIdleLogout";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useTopPerformerCelebration } from "../hooks/useTopPerformerCelebration";
import { useLang } from "../contexts/LanguageContext";
import { useAuth } from "../../../context/AuthContext";
// Referral System v1 - additive card. Renders nothing if the backend
// referral API is unavailable or admin has hidden the card.
// RewardsHub composes ReferralBonusCard (folded into the unified reward block).
// Reward-kind v1.0.2 -- premium Rewards & Vouchers hub (Mongo-backed,
// no localStorage truth). Self-manages its own loading / empty states.
// VoucherHub + EduTalkPassHub are composed inside RewardsHub.

interface Props {
  student: StudentData;
  password: string;
  initialPoints: number;
  onLogout: () => void;
}

/**
 * Dashboard.tsx -- My Portal Premium Reconstruction v1
 *
 * Layout reorganised into 7 distinct premium sections (Mongo-backed,
 * no localStorage truth):
 *
 *   1. Wallet Hero          (slim StudentHeader -- identity + PointsPill)
 *   2. Performance Glance   (real scores only; honest empty state)
 *   3. Rewards & Vouchers   (LatestRewardCard strip + VoucherHub)
 *   4. Learning Access      (PaymentBanner + TuitionCountdown grouped)
 *   5. Referral Bonus       (existing component, self-hides on 404)
 *   6. Transaction History  (real Mongo points_transactions only)
 *   7. Monthly Review       (existing MonthlyPerformance + Criteria + ...)
 *
 * NOTHING is invented. Every section reads from the same hooks the
 * legacy Dashboard used (useStudentData / useHistory / useComments /
 * usePoints / useTopPerformerCelebration). Empty / error states are
 * honest -- no fake voucher cards, no fake reward feed, no fake rows.
 *
 * Existing flows preserved verbatim:
 *   - Send Points modal (onSend -> setSendOpen)
 *   - Coupon validate/redeem (unchanged; manual entry lives inside
 *     VoucherHub's ManualCouponEntry slot)
 *   - Login Reward popup (PointsTopUpPopup unchanged)
 *   - Restriction watchdog (unchanged)
 *   - Idle logout (unchanged)
 */
export function Dashboard({ student: initial, password, initialPoints, onLogout }: Props) {
  const { t } = useLang();
  // v7.9.9 -- DebugDrawer is gated to elevated roles only.
  const { student: authUser } = useAuth();
  const roleLower = String((authUser as any)?.role || "student").toLowerCase();
  const canViewDebug = roleLower === "teacher" || roleLower === "admin";

  /* ---- Restriction watchdog ---- */
  const [restrictionMsg, setRestrictionMsg] = useState<string>(
    (initial.Restriction || initial.restriction || "").trim(),
  );
  const handleRestriction = useCallback((msg: string) => {
    setRestrictionMsg(msg);
  }, []);

  /* ---- Live data hooks ---- */
  const { data: student } = useStudentData(initial, handleRestriction);
  const { data: comments, loading: commentsLoading } = useComments(
    initial.StudentID,
  );
  const enrolledAt = (initial as any).enrolled_at || (initial as any).enrolledAt || undefined;
  const { data: history, loading: historyLoading } = useHistory(initial.StudentID, enrolledAt);
  const {
    points,
    receiveEvent,
    consumeReceiveEvent,
    spendEvent,
    consumeSpendEvent,
    previousPoints,
    refresh: refreshPoints,
    debug: pointsDebug,
    triggerTestEvent,
    loading: pointsLoading,
    rewardVersion,
  } = usePoints(initial.StudentID, password, initialPoints);
  const { online } = useConnectionStatus();

  const scores = extractScores(student);
  const overall = overallScore(scores);

  /* ---- Top performer celebration / streak / improvements ---- */
  const { showToast, dismiss, improvedByCriterion, excellentStreak } =
    useTopPerformerCelebration(initial.StudentID, history, overall);

  /* ---- UI state ---- */
  const [scoreGuideOpen, setScoreGuideOpen] = useState(true);
  const [sendOpen, setSendOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Phase 5 v1.0.1 -- bumped after a P2P send / coupon / top-up so the
  // authoritative MongoDB transaction timeline re-fetches without
  // touching the polled balance flow.
  const [txRefreshKey, setTxRefreshKey] = useState(0);
  const [showFab, setShowFab] = useState(false);
  const [drawerKey, setDrawerKey] = useState<CriterionKey | null>(null);

  useIdleLogout(onLogout);

  useEffect(() => {
    const onScroll = () => setShowFab(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Live PaymentAmount mutated by an applied coupon (legacy behaviour
  // preserved). When the coupon flow lives inside VoucherHub now, the
  // unchanged backend redeem still returns a fresh newAmount that the
  // existing useStudentData poll will eventually reflect. We keep the
  // local override for instant UI feedback.
  const [paymentAmount, setPaymentAmount] = useState<number | undefined>(
    student.PaymentAmount,
  );
  useEffect(() => {
    setPaymentAmount(student.PaymentAmount);
  }, [student.PaymentAmount]);
  const studentForDisplay: StudentData = { ...student, PaymentAmount: paymentAmount };

  return (
    <div className="relative min-h-screen">
      <AuroraBackdrop />

      <ConnectionBanner online={online} onRetry={refreshPoints} />

      <PortalAppBar
        onScoreGuide={() => setScoreGuideOpen(true)}
        onPrint={() => window.print()}
        onLogout={onLogout}
      />

      <TopPerformerToast show={showToast} onDismiss={dismiss} />

      <PageShell>
        <div className="space-y-7" data-testid="my-portal">
          {/* 1) Student Hero -- identity + wallet/points + Send Points.
                Lumio: hero-first, full-bleed leading surface (no eyebrow
                section wrapper). Reuses the same data + PointsPill. */}
          <StudentHero
            student={studentForDisplay}
            points={points}
            receiveEvent={receiveEvent}
            onConsumeEvent={consumeReceiveEvent}
            spendEvent={spendEvent}
            onConsumeSpendEvent={consumeSpendEvent}
            previousPoints={previousPoints}
            onSendPoints={() => setSendOpen(true)}
            excellentStreak={excellentStreak}
          />

          {/* 1b) Speaking Lab — one-tap live-session card. Appears ONLY
                when there is genuinely a live session the student can
                join; it fails SILENT (renders nothing) on any error, so
                it can never surface a Speaking Lab connectivity problem
                onto the main dashboard. Wrapped in the boundary as
                defense-in-depth against an unexpected render crash. When
                hidden it occupies zero space. */}
          <PrizePoolCardBoundary>
            <SpeakingLabLiveCard />
          </PrizePoolCardBoundary>

          {/* 2) Quick actions shelf -- wired to the existing Dashboard
                flows (Score Guide modal, Send modal, print, Top-Up
                modal). Speaking Lab is NOT a tile here — it's the
                auto-hiding live card above, which only appears when a
                session is actually live. */}
          <QuickActionsShelf
            onScoreGuide={() => setScoreGuideOpen(true)}
            onSendPoints={() => setSendOpen(true)}
            onPrint={() => window.print()}
            onTopUp={() => setTopUpOpen(true)}
          />

          {/* 3) Learning Access / Tuition -- moved directly beneath the hero
                so payment status is seen before performance/rewards. */}
          <TuitionStrip student={studentForDisplay} />

          {/* 4) Performance Glance -- premium snapshot, real data only,
                hooks the student to scroll into the full review below. */}
          <PortalSection title="Performance" eyebrow accent="violet">
            <PerformanceGlance
              scores={scores}
              overall={overall}
              excellentStreak={excellentStreak}
              improvedByCriterion={improvedByCriterion}
              onSeeFullReview={() => {
                setReviewOpen(true);
                requestAnimationFrame(() => {
                  document
                    .querySelector('[data-portal-section="Monthly Review"]')
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              }}
            />
          </PortalSection>

          {/* 5) Rewards & Vouchers Hub (Lumio) -- LatestRewardCard, VoucherHub,
                EduTalkPassHub AND Referral folded into one coral-accented
                reward block. Each child keeps its own data hooks, refresh
                keys, and honest empty/error/self-hide states. VoucherHub
                re-loads on `txRefreshKey` bumps (coupon redeem, send-points,
                top-up) only -- never on every points poll. */}
          <RewardsHub
            studentId={student.StudentID}
            rewardVersion={rewardVersion}
            spendEvent={spendEvent}
            refreshKey={txRefreshKey}
          />

          {/* 6) Transaction History -- Phase 5 authoritative MongoDB
                points ledger. Re-fetches on balance change OR P2P send. */}
          <PortalSection title="Activity" eyebrow accent="teal">
            <TransactionTimeline
              refreshKey={Math.floor(points) + txRefreshKey}
              initialLimit={6}
            />
          </PortalSection>

          {/* 7) Monthly Review -- COLLAPSED BY DEFAULT (Lumio). Expanding
                reveals the existing evaluation surfaces unchanged. */}
          <MonthlyReviewExpander
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            overall={overall}
          >
            <MonthlyPerformance scores={scores} />

            <CriteriaShelf
              scores={scores}
              improvedByCriterion={improvedByCriterion}
              onSelect={setDrawerKey}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <OverallScore scores={scores} />
              <FeedbackTriad student={studentForDisplay} />
            </div>

            <CommentsSection
              studentId={student.StudentID}
              comments={comments}
              loading={commentsLoading}
            />

            <PerformanceChart history={history} loading={historyLoading} />
          </MonthlyReviewExpander>

          <footer className="text-center text-xs text-[color:var(--color-ink-mute)] py-6">
            {t("footer").replace("{year}", String(new Date().getFullYear()))}
          </footer>
        </div>
      </PageShell>

      {/* Floating "scroll to top" FAB */}
      <AnimatePresence>
        {showFab && (
          <motion.button
            initial={{ opacity: 0, scale: 0.7, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: 24 }}
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="no-print lumio-fab h-12 w-12 rounded-full ink-shadow-lg flex items-center justify-center"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-surface)",
            }}
            aria-label="Scroll to top"
            data-testid="scroll-to-top-fab"
          >
            <ArrowUp className="h-5 w-5" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Modals -- wiring preserved verbatim. */}
      <ScoreGuideModal
        open={scoreGuideOpen}
        onClose={() => setScoreGuideOpen(false)}
      />
      <SendPointsModal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        studentId={student.StudentID}
        password={password}
        currentPoints={points}
        onPointsChanged={() => {
          refreshPoints();
          setTxRefreshKey((k) => k + 1);
        }}
      />
      <RestrictionModal
        open={Boolean(restrictionMsg)}
        message={restrictionMsg}
        onForceLogout={onLogout}
      />
      <CriterionDetailDrawer
        selectedKey={drawerKey}
        score={drawerKey ? scores[drawerKey] : null}
        onClose={() => setDrawerKey(null)}
      />

      {/* Points Top-Up Popup -- shows once per session, 2s after login. */}
      <PointsTopUpPopup
        studentId={student.StudentID}
        onCredited={() => {
          refreshPoints();
          setTxRefreshKey((k) => k + 1);
        }}
      />

      {/* Manual Top-Up -- opened from the QuickActionsShelf. Reuses the
          existing PointsPurchaseModal payment flow verbatim (same public
          contract as LibraryTopUpButton); no payment logic is changed. */}
      {topUpOpen && (
        <PointsPurchaseModal
          studentId={student.StudentID}
          currentBalance={points}
          triggerReason="manual_topup"
          onClose={() => setTopUpOpen(false)}
          onCredited={() => {
            refreshPoints();
            setTxRefreshKey((k) => k + 1);
            setTopUpOpen(false);
          }}
        />
      )}

      {canViewDebug && (
        <DebugDrawer
          debug={pointsDebug}
          loading={pointsLoading}
          currentPoints={points}
          onRefreshNow={refreshPoints}
          onTriggerTest={triggerTestEvent}
        />
      )}
    </div>
  );
}

/**
 * PortalSection -- lightweight, purely-presentational premium section
 * wrapper. Renders a small eyebrow heading above its children and
 * groups them with consistent vertical rhythm. It does NOT alter any
 * child behaviour, data, or props -- it only adds visual structure so
 * the page reads as distinct premium blocks instead of one long stack.
 *
 * The `data-portal-section` attribute is the anchor used by
 * PerformanceGlance to scroll to the Monthly Review section. Do not
 * rename it without updating that component.
 */
function PortalSection({
  title,
  description,
  eyebrow = false,
  accent = "teal",
  children,
}: {
  title: string;
  description?: string;
  eyebrow?: boolean;
  /** Aurora accent family for the section eyebrow dot. */
  accent?: "teal" | "coral" | "violet";
  children: ReactNode;
}) {
  return (
    <section
      className="portal-section"
      data-portal-section={title}
      data-accent={accent}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2
          className={
            eyebrow
              ? "text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-ink-mute)] flex items-center"
              : "display text-base font-bold text-[color:var(--color-ink)] flex items-center"
          }
        >
          {eyebrow && <span aria-hidden className="aurora-eyebrow-dot" />}
          {title}
        </h2>
        {description ? (
          <span className="text-[11px] text-[color:var(--color-ink-mute)] truncate">
            {description}
          </span>
        ) : null}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
