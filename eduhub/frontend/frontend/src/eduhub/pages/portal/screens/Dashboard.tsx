import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import type { CriterionKey, StudentData } from "../types";
import { extractScores, overallScore } from "../lib/scoring";
import { TopBar } from "../components/layout/TopBar";
import { AuroraBackdrop } from "../components/layout/AuroraBackdrop";
import { PageShell } from "../components/layout/PageShell";
import { ConnectionBanner } from "../components/layout/ConnectionBanner";
import { PaymentBanner } from "../components/dashboard/PaymentBanner";
import { StudentHeader } from "../components/dashboard/StudentHeader";
import { MonthlyPerformance } from "../components/dashboard/MonthlyPerformance";
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
import { useStudentData } from "../hooks/useStudentData";
import { useComments } from "../hooks/useComments";
import { useHistory } from "../hooks/useHistory";
import { usePoints } from "../hooks/usePoints";
import { useIdleLogout } from "../hooks/useIdleLogout";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useTopPerformerCelebration } from "../hooks/useTopPerformerCelebration";
import { useLang } from "../contexts/LanguageContext";
import { useAuth } from "../../../context/AuthContext";

interface Props {
  student: StudentData;
  password: string;
  initialPoints: number;
  onLogout: () => void;
}

export function Dashboard({ student: initial, password, initialPoints, onLogout }: Props) {
  const { t } = useLang();
  // v7.9.9 — DebugDrawer is gated to elevated roles only.
  // Previously it rendered in development for everyone; now it is
  // visible ONLY to authenticated teacher / admin accounts, regardless
  // of NODE_ENV, so production students can never toggle the debug
  // overlay or trigger the +N points test events from the UI.
  const { student: authUser } = useAuth();
  const roleLower = String((authUser as any)?.role || "student").toLowerCase();
  const canViewDebug = roleLower === "teacher" || roleLower === "admin";

  /* ---- Restriction watchdog: triggers force-logout countdown modal ---- */
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
  const { data: history, loading: historyLoading } = useHistory(initial.StudentID);
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
  const [showFab, setShowFab] = useState(false);
  const [drawerKey, setDrawerKey] = useState<CriterionKey | null>(null);

  useIdleLogout(onLogout);

  useEffect(() => {
    const onScroll = () => setShowFab(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Mutate live PaymentAmount on coupon apply (matches original behaviour).
  const [paymentAmount, setPaymentAmount] = useState<number | undefined>(
    student.PaymentAmount,
  );
  useEffect(() => {
    setPaymentAmount(student.PaymentAmount);
  }, [student.PaymentAmount]);
  const handleCoupon = useCallback((newAmount: number) => {
    setPaymentAmount(newAmount);
  }, []);
  const studentForDisplay: StudentData = { ...student, PaymentAmount: paymentAmount };

  return (
    <div className="relative min-h-screen">
      <AuroraBackdrop />

      <ConnectionBanner online={online} onRetry={refreshPoints} />

      <TopBar
        variant="dashboard"
        onScoreGuide={() => setScoreGuideOpen(true)}
        onPrint={() => window.print()}
        onLogout={onLogout}
      />

      <TopPerformerToast show={showToast} onDismiss={dismiss} />

      <PageShell>
        <PaymentBanner student={studentForDisplay} />

        <StudentHeader
          student={studentForDisplay}
          points={points}
          receiveEvent={receiveEvent}
          onConsumeEvent={consumeReceiveEvent}
          spendEvent={spendEvent}
          onConsumeSpendEvent={consumeSpendEvent}
          previousPoints={previousPoints}
          onSendPoints={() => setSendOpen(true)}
          onCouponApplied={handleCoupon}
          excellentStreak={excellentStreak}
          rewardVersion={rewardVersion}
        />

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

        <footer className="text-center text-xs text-[color:var(--color-ink-mute)] py-6">
          {t("footer").replace("{year}", String(new Date().getFullYear()))}
        </footer>
      </PageShell>

      {/* Floating "scroll to top" FAB */}
      <AnimatePresence>
        {showFab && (
          <motion.button
            initial={{ opacity: 0, scale: 0.7, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: 24 }}
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="no-print fixed bottom-6 right-6 z-30 h-12 w-12 rounded-full ink-shadow-lg flex items-center justify-center"
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

      {/* Modals */}
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
        onPointsChanged={() => refreshPoints()}
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
