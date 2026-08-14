import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalShell } from "../primitives/ModalShell";
import { useLang } from "../../contexts/LanguageContext";
import { RESTRICTION_LOGOUT_COUNTDOWN } from "../../config/sections";

interface Props {
  open: boolean;
  message: string;
  /** Called when the countdown ends OR when the user clicks "Sign Out". */
  onForceLogout: () => void;
}

/**
 * Hard-gate modal — no close/dismiss path. The only outcome is sign-out.
 * Counts down for RESTRICTION_LOGOUT_COUNTDOWN seconds then auto-logs-out.
 */
export function RestrictionModal({ open, message, onForceLogout }: Props) {
  const { t, tpl, num } = useLang();
  const [countdown, setCountdown] = useState(RESTRICTION_LOGOUT_COUNTDOWN);

  useEffect(() => {
    if (!open) return;
    setCountdown(RESTRICTION_LOGOUT_COUNTDOWN);
    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(tick);
          // Schedule on next tick to avoid setState-during-render warnings.
          setTimeout(onForceLogout, 0);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [open, onForceLogout]);

  return (
    <ModalShell
      open={open}
      onClose={onForceLogout}
      title={t("accessRevoked")}
      subtitle="ការចូលប្រើត្រូវបានដកយក"
      icon={ShieldAlert}
      headerColor="var(--color-needs)"
      dismissible={false}
      maxWidth="max-w-md"
      testId="restriction-modal"
    >
      <div className="p-6">
        <p className="text-sm text-[color:var(--color-ink)] leading-relaxed whitespace-pre-line">
          {message || "Your access has been temporarily restricted by the administrator."}
        </p>
        <div
          className="mt-4 text-center text-sm font-semibold mono"
          style={{ color: "var(--color-needs)" }}
          data-testid="restriction-countdown"
        >
          {tpl(t("sessionEndingTpl"), { n: num(countdown) })}
        </div>
        <button
          onClick={onForceLogout}
          data-testid="restriction-logout-btn"
          className="mt-5 w-full py-3 rounded-xl font-semibold transition"
          style={{
            background: "var(--color-needs)",
            color: "var(--color-surface)",
          }}
        >
          {t("signOutNow")}
        </button>
      </div>
    </ModalShell>
  );
}
