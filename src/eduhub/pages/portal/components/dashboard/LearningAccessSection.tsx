/**
 * LearningAccessSection.tsx -- My Portal Premium Reconstruction v1
 *
 * Groups the tuition / access surface into one premium block so the
 * Wallet Hero can stay focused on points + identity.
 *
 * Contents (existing components, only the grouping is new):
 *   - PaymentBanner    (self-hides when not urgent)
 *   - TuitionCountdown (real student.NextDueDate / PaymentAmount)
 *
 * No new data, no new API call. The card itself never invents
 * payment status -- TuitionCountdown's existing branches drive
 * everything.
 */
import type { StudentData } from "../../types";
import { daysUntil } from "../../lib/scoring";
import { PaymentBanner } from "./PaymentBanner";
import { TuitionCountdown } from "./TuitionCountdown";

interface Props {
  student: StudentData;
}

export function LearningAccessSection({ student }: Props) {
  const days = daysUntil(student.NextDueDate);

  return (
    <div className="space-y-3" data-testid="learning-access-section">
      <PaymentBanner student={student} />
      <TuitionCountdown
        daysLeft={days}
        dueDate={student.NextDueDate}
        amount={student.PaymentAmount}
        status={student.TuitionStatus}
      />
    </div>
  );
}

export default LearningAccessSection;
