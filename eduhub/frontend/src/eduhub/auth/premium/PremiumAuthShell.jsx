// PremiumAuthShell.jsx — white, calm, official DY-branded canvas for
// every student authentication surface. Provides:
//   • SafeArea-aware top/bottom padding (iOS Safari notch + home indicator)
//   • Optional top bar (back link + language toggle)
//   • Centered max-width container
//   • Subtle gold/blue ambient gradient — never overpowering
//
// Children render the actual auth surface (credential card, prompt, etc).
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import "./premium-auth.css";

/**
 * Props:
 *   children:    ReactNode
 *   showBack:    boolean        render the "Back to Dashboard" pill (default true)
 *   backTo:      string         destination for the back link (default "/")
 *   backLabel:   string         label override (default "Back to Dashboard")
 *   rightSlot:   ReactNode      optional right-side slot in top bar (e.g. lang toggle)
 *   footer:      ReactNode      optional content rendered at the bottom (e.g. Telegram support)
 *   testID:      string         data-testid root (default "premium-auth-shell")
 */
export default function PremiumAuthShell({
  children,
  showBack = true,
  backTo = "/",
  backLabel = "Back to Dashboard",
  rightSlot = null,
  footer = null,
  testID = "premium-auth-shell",
}) {
  return (
    <div className="dy-auth-shell" data-testid={testID}>
      <div className="dy-auth-shell-bg" aria-hidden />

      {/* Top bar */}
      {(showBack || rightSlot) && (
        <div
          className="relative z-10 flex items-center justify-between"
          style={{ minHeight: 36 }}
        >
          {showBack ? (
            <motion.div
              whileHover={{ x: -2 }}
              whileTap={{ scale: 0.97 }}
              transition={{ type: "spring", stiffness: 320, damping: 24 }}
            >
              <Link
                to={backTo}
                data-testid="premium-auth-back"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#4B5563] hover:text-[#0B1B36] transition-colors"
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                {backLabel}
              </Link>
            </motion.div>
          ) : (
            <span />
          )}
          {rightSlot ? <div data-testid="premium-auth-rightslot">{rightSlot}</div> : <span />}
        </div>
      )}

      {/* Centered content */}
      <div className="dy-auth-shell-inner">{children}</div>

      {/* Optional footer slot */}
      {footer && (
        <div
          className="relative z-10 mx-auto w-full max-w-[420px] pt-2 pb-1 text-center text-[12.5px] text-[#6B7280]"
          data-testid="premium-auth-footer"
        >
          {footer}
        </div>
      )}
    </div>
  );
}
