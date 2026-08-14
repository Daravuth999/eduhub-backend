import { Gift } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { motion } from "framer-motion";
import { LatestRewardCard } from "./LatestRewardCard";
import { VoucherHub } from "./VoucherHub";
import { EduTalkPassHub } from "./EduTalkPassHub";
import ReferralBonusCard from "../../../../components/ReferralBonusCard";
import type { SpendDeltaEvent } from "../../hooks/usePoints";

interface Props {
  studentId: string;
  rewardVersion: number;
  spendEvent: SpendDeltaEvent | null;
  refreshKey: number;
}

/**
 * RewardsHub -- Lumio unified reward block.
 *
 * Groups the existing reward surfaces (LatestRewardCard, VoucherHub,
 * EduTalkPassHub) and the Referral bonus into ONE coral-accented section
 * so they read as a single premium "Rewards" experience instead of two
 * separate eyebrow sections (which left a dangling empty Referral header
 * when the referral card self-hides).
 *
 * It only re-composes + restyles; every child keeps its own data hooks,
 * refresh keys, honest empty/error states, and self-hide contracts.
 */
export function RewardsHub({
  studentId,
  rewardVersion,
  spendEvent,
  refreshKey,
}: Props) {
  const { lang } = useLang();
  const reduced = useReducedMotion();
  const isEn = lang !== "km";

  return (
    <motion.section
      data-testid="portal-rewards-hub"
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <header className="mb-3 flex items-center gap-2">
        <span className="aurora-icon-badge h-6 w-6" data-accent="coral" aria-hidden>
          <Gift className="h-3.5 w-3.5" />
        </span>
        <h2 className="lumio-eyebrow">
          {isEn ? "Rewards & Vouchers" : "រង្វាន់ និងប័ណ្ណ"}
        </h2>
      </header>

      <div className="space-y-3">
        <LatestRewardCard
          studentId={studentId}
          rewardVersion={rewardVersion}
          spendEvent={spendEvent}
          refreshKey={refreshKey}
        />
        <VoucherHub refreshKey={refreshKey} />
        <EduTalkPassHub refreshKey={refreshKey} />
        <ReferralBonusCard />
      </div>
    </motion.section>
  );
}
