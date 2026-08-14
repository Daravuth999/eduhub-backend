import { motion } from "framer-motion";
import { Award, Sparkles, Flame } from "lucide-react";
import type { StudentData } from "../../types";
import {
  avatarUrl,
  isTopPerformer,
  overallScore,
  extractScores,
} from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";
import { Pill } from "../primitives/Pill";
import { Card } from "../primitives/Card";
import { PointsPill } from "./PointsPill";
import type {
  PointsDeltaEvent,
  SpendDeltaEvent,
} from "../../hooks/usePoints";

/**
 * StudentHeader.tsx -- My Portal Premium Reconstruction v1
 *
 * Slimmed down to a true "Wallet Hero" surface. The previous version
 * mounted six surfaces in one Card (avatar + identity + PointsPill +
 * LatestRewardCard + TuitionCountdown + CouponForm), which made the
 * wallet feel like a checkout form and crowded the entire portal.
 *
 * NOW the wallet contains ONLY:
 *   - Avatar
 *   - Name + Student ID + Khmer welcome
 *   - Optional Top / Streak status chip
 *   - PointsPill (balance + Send Points)
 *
 * The reward feed (LatestRewardCard) has been promoted into the
 * Rewards & Vouchers Hub. The tuition countdown + payment banner now
 * live in their own "Learning Access" section. The coupon form is
 * exposed once -- inside VoucherHub's secondary manual-entry slot --
 * so the wallet hero is purely about balance + identity + transfer.
 *
 * Props that previously fed the now-moved children (rewardVersion,
 * spendEvent, onCouponApplied) have been removed from this component
 * to keep the contract honest. Dashboard.tsx routes those values
 * directly to the components that now own them.
 */
interface Props {
  student: StudentData;
  points: number;
  receiveEvent: PointsDeltaEvent | null;
  onConsumeEvent: () => void;
  spendEvent: SpendDeltaEvent | null;
  onConsumeSpendEvent: () => void;
  previousPoints: number;
  onSendPoints: () => void;
  excellentStreak: number;
}

export function StudentHeader({
  student,
  points,
  receiveEvent,
  onConsumeEvent,
  spendEvent,
  onConsumeSpendEvent,
  previousPoints,
  onSendPoints,
  excellentStreak,
}: Props) {
  const { t, tpl, num } = useLang();
  const overall = overallScore(extractScores(student));
  const top = isTopPerformer(overall);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      data-testid="wallet-hero"
    >
      <Card emphasis className="p-5 sm:p-6" accentEdge="var(--color-accent)">
        <div className="flex items-center gap-4 sm:gap-5">
          {/* Avatar - slimmer than before so it does not dominate. */}
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, type: "spring", damping: 14 }}
            className="relative shrink-0"
          >
            <img
              src={avatarUrl(student.Name)}
              alt={student.Name}
              className="h-16 w-16 sm:h-20 sm:w-20 rounded-2xl object-cover border-4 border-[color:var(--color-surface)] ink-shadow"
            />
            {top && (
              <div
                aria-hidden
                data-accent="gold"
                className="aurora-icon-badge absolute -bottom-1.5 -right-1.5 h-7 w-7"
              >
                <Award className="h-3.5 w-3.5" />
              </div>
            )}
          </motion.div>

          {/* Identity column. */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h1
                className="display text-xl sm:text-2xl font-bold leading-tight text-[color:var(--color-ink)] truncate"
                data-testid="student-name"
              >
                {student.Name}
              </h1>
              {top && (
                <Pill tone="good" filled className="!rounded-full">
                  <Sparkles className="h-3 w-3" /> Top
                </Pill>
              )}
              {excellentStreak >= 2 && (
                <Pill tone="warm" filled className="!rounded-full" data-testid="streak-badge">
                  <Flame className="h-3 w-3" />
                  <span>{tpl(t("excellentStreakTpl"), { n: num(excellentStreak) })}</span>
                </Pill>
              )}
            </div>
            <p className="text-xs sm:text-sm text-[color:var(--color-ink-soft)] mt-1">
              ID: <span className="mono font-semibold">{student.StudentID}</span>
            </p>
            <p className="khmer text-[11px] sm:text-xs text-[color:var(--color-ink-mute)] mt-0.5">
              {t("welcome")}
            </p>
          </div>
        </div>

        {/* PointsPill row -- full width on mobile, gives the balance and
            Send Points action the breathing room they deserve. */}
        <div className="mt-5">
          <PointsPill
            points={points}
            receiveEvent={receiveEvent}
            onConsumeEvent={onConsumeEvent}
            spendEvent={spendEvent}
            onConsumeSpendEvent={onConsumeSpendEvent}
            previousPoints={previousPoints}
            onSend={onSendPoints}
          />
        </div>
      </Card>
    </motion.div>
  );
}
