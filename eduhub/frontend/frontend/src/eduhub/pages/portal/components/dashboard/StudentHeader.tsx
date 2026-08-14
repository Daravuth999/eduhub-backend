import { motion } from "framer-motion";
import { Award, Sparkles, Flame } from "lucide-react";
import type { StudentData } from "../../types";
import {
  avatarUrl,
  daysUntil,
  isTopPerformer,
  overallScore,
  extractScores,
} from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";
import { Pill } from "../primitives/Pill";
import { Card } from "../primitives/Card";
import { TuitionCountdown } from "./TuitionCountdown";
import { PointsPill } from "./PointsPill";
import { CouponForm } from "./CouponForm";
import { LatestRewardCard } from "./LatestRewardCard";
import type {
  PointsDeltaEvent,
  SpendDeltaEvent,
} from "../../hooks/usePoints";

interface Props {
  student: StudentData;
  points: number;
  receiveEvent: PointsDeltaEvent | null;
  onConsumeEvent: () => void;
  spendEvent: SpendDeltaEvent | null;
  onConsumeSpendEvent: () => void;
  previousPoints: number;
  onSendPoints: () => void;
  onCouponApplied: (newAmount: number, percent: number) => void;
  excellentStreak: number;
  rewardVersion: number;
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
  onCouponApplied,
  excellentStreak,
  rewardVersion,
}: Props) {
  const { t, tpl, num } = useLang();
  const overall = overallScore(extractScores(student));
  const top = isTopPerformer(overall);
  const days = daysUntil(student.NextDueDate);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <Card emphasis className="p-5 sm:p-7" accentEdge="var(--color-accent)">
        <div className="flex flex-col lg:flex-row items-start lg:items-center gap-5 lg:gap-7">
          {/* Avatar */}
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, type: "spring", damping: 14 }}
            className="relative shrink-0"
          >
            <img
              src={avatarUrl(student.Name)}
              alt={student.Name}
              className="h-20 w-20 sm:h-24 sm:w-24 rounded-2xl object-cover border-4 border-[color:var(--color-surface)] ink-shadow"
            />
            {top && (
              <div
                className="absolute -bottom-2 -right-2 h-9 w-9 rounded-xl flex items-center justify-center ink-shadow"
                style={{ background: "var(--color-good)" }}
              >
                <Award className="h-4.5 w-4.5 text-[color:var(--color-surface)]" />
              </div>
            )}
          </motion.div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className="display text-2xl sm:text-3xl font-bold leading-tight text-[color:var(--color-ink)] truncate"
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
            <p className="text-sm text-[color:var(--color-ink-soft)] mt-1">
              ID: <span className="mono font-semibold">{student.StudentID}</span>
            </p>
            <p className="khmer text-xs text-[color:var(--color-ink-mute)] mt-0.5">
              {t("welcome")}
            </p>
          </div>

          {/* Right column: PointsPill + LatestRewardCard + Tuition */}
          <div className="w-full lg:w-[340px] flex flex-col gap-3">
            <PointsPill
              points={points}
              receiveEvent={receiveEvent}
              onConsumeEvent={onConsumeEvent}
              spendEvent={spendEvent}
              onConsumeSpendEvent={onConsumeSpendEvent}
              previousPoints={previousPoints}
              onSend={onSendPoints}
            />
            <LatestRewardCard
              studentId={student.StudentID}
              rewardVersion={rewardVersion}
              spendEvent={spendEvent}
            />
            <TuitionCountdown
              daysLeft={days}
              dueDate={student.NextDueDate}
              amount={student.PaymentAmount}
              status={student.TuitionStatus}
            />
          </div>
        </div>

        <CouponForm studentId={student.StudentID} onApplied={onCouponApplied} />
      </Card>
    </motion.div>
  );
}
