import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, Check, BookOpen, Mic, TrendingUp, AlertCircle } from "lucide-react";
import useBellRingPermission from "@/eduhub/hooks/useBellRingPermission";

/**
 * BellRingGate — full-screen bilingual permission overlay.
 * v2 (2026-01-15): after successful enable, performs a full page reload
 * so the existing Header <PushNotificationBell> immediately reflects the
 * new subscribed state (no more animated "attention" glow).
 */
export default function BellRingGate({ open, onClose, redirectOnDeny = "/" }) {
  const navigate = useNavigate();
  const { permission, supported, request, fireWelcome } = useBellRingPermission();
  const [state, setState] = useState("prompt");

  // Auto-close if permission flips to granted from elsewhere.
  useEffect(() => {
    if (!open) return;
    if (permission === "granted" && state === "prompt") onClose?.();
  }, [permission, open, state, onClose]);

  const handleAllow = async () => {
    if (permission === "denied") {
      setState("blocked");
      setTimeout(() => {
        setState("prompt");
        onClose?.();
        navigate(redirectOnDeny, { replace: true });
      }, 2200);
      return;
    }
    setState("asking");
    const result = await request();
    if (result === "granted") {
      setState("success");
      fireWelcome();
      setTimeout(() => {
        // v2 — Full reload so the Header's <PushNotificationBell> picks
        // up the new server-side subscription state. Without this, the
        // bell continues to animate its "attention" halo even though
        // the student has now successfully enabled remote push.
        // Reload is safe in PWAs and lands the user on the same URL.
        try {
          window.location.reload();
        } catch (e) {
          onClose?.();
          setState("prompt");
        }
      }, 2000);
    } else {
      setState("dismissing");
      setTimeout(() => {
        onClose?.();
        setState("prompt");
        navigate(redirectOnDeny, { replace: true });
      }, 900);
    }
  };

  if (!open) return null;
  if (!supported) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="bellring-gate"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] grid place-items-center px-4 bg-black/80 backdrop-blur-lg"
        data-testid="bellring-gate"
      >
        <motion.div
          initial={{ scale: 0.9, y: 24, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.95, y: 12, opacity: 0 }}
          transition={{ type: "spring", damping: 22, stiffness: 260 }}
          className="relative w-full max-w-[440px] rounded-3xl overflow-hidden"
          style={{
            background:
              "radial-gradient(130% 110% at 10% 0%, rgba(212,168,67,0.28), transparent 55%), linear-gradient(165deg, #2A1F38 0%, #150F1D 100%)",
            boxShadow:
              "0 40px 100px -20px rgba(0,0,0,0.75), 0 0 0 1px rgba(212,168,67,0.25), inset 0 1px 0 rgba(255,255,255,0.07)",
          }}
        >
          {(state === "prompt" || state === "asking") && (
            <div className="p-7" data-testid="bellring-prompt">
              <motion.div
                animate={{ rotate: [0, -8, 8, -4, 4, 0], scale: [1, 1.05, 1] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full"
                style={{
                  background:
                    "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
                  boxShadow: "0 18px 40px rgba(212,168,67,0.45)",
                }}
              >
                <Bell className="h-8 w-8 text-ink" strokeWidth={2.5} />
              </motion.div>

              <h2
                className="text-center font-display text-[20px] text-parchment leading-tight mb-1"
                style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
              >
                ដើម្បីបន្ត សូមចុច "Allow" ឬ "អនុញ្ញាត"
              </h2>
              <p className="text-center text-[13.5px] text-parchment/80 mb-5">
                To continue, please tap <b className="text-gold">Allow</b> to enable notifications.
              </p>

              <div className="space-y-2 mb-6">
                {[
                  { Icon: BookOpen, en: "Learning updates", km: "ព័ត៌មានថ្មីពីការសិក្សា" },
                  { Icon: Mic,      en: "Speaking feedback", km: "មតិយោបល់ការនិយាយ" },
                  { Icon: TrendingUp, en: "Progress tracking", km: "តាមដានការរីកចម្រើន" },
                ].map(({ Icon, en, km }) => (
                  <div
                    key={en}
                    className="flex items-center gap-3 rounded-xl bg-black/30 border border-white/5 px-3 py-2.5"
                  >
                    <Icon className="h-4 w-4 flex-none text-gold" />
                    <div className="text-[12px] leading-tight">
                      <div className="text-parchment font-semibold">{en}</div>
                      <div className="text-faded">{km}</div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={handleAllow}
                disabled={state === "asking"}
                data-testid="bellring-allow-btn"
                className="w-full relative overflow-hidden rounded-xl py-3.5 text-sm font-bold tracking-wide text-ink disabled:cursor-not-allowed disabled:opacity-70"
                style={{
                  background:
                    "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                  boxShadow:
                    "0 14px 28px rgba(212,168,67,0.45), inset 0 1px 0 rgba(255,255,255,0.6)",
                }}
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none"
                  animate={{ x: ["-20%", "420%"] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: "linear", repeatDelay: 0.8 }}
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
                    filter: "blur(2px)",
                  }}
                />
                <span className="relative inline-flex items-center justify-center gap-2">
                  <Bell className="h-4 w-4" />
                  {state === "asking" ? "Subscribing…" : "Allow Notifications"}
                </span>
              </button>

              <p className="mt-3 text-center text-[10.5px] text-faded leading-snug">
                We'll never spam. Just classroom announcements, feedback, and your progress.
              </p>
            </div>
          )}

          {state === "success" && (
            <div className="p-8 text-center" data-testid="bellring-success">
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", damping: 14, stiffness: 220 }}
                className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full"
                style={{
                  background: "linear-gradient(135deg, #B8F3D2 0%, #00BFA5 100%)",
                  boxShadow: "0 18px 40px rgba(0,191,165,0.5)",
                }}
              >
                <Check className="h-8 w-8 text-ink" strokeWidth={3} />
              </motion.div>
              <h2
                className="font-display text-[22px] text-parchment leading-tight mb-1"
                style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
              >
                Notifications enabled
              </h2>
              <p className="text-[13.5px] text-parchment/80 mb-1">
                You will now receive learning updates and feedback.
              </p>
              <p className="text-[12.5px] text-faded">
                ឥឡូវនេះ អ្នកនឹងទទួលបានព័ត៌មាន និងមតិយោបល់។
              </p>
            </div>
          )}

          {state === "blocked" && (
            <div className="p-8 text-center" data-testid="bellring-blocked">
              <div
                className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full"
                style={{ background: "rgba(255,174,174,0.18)", border: "1px solid rgba(255,174,174,0.4)" }}
              >
                <AlertCircle className="h-6 w-6 text-[#FFAEAE]" />
              </div>
              <h2 className="font-display text-[18px] text-parchment mb-2">
                Notifications are blocked
              </h2>
              <p className="text-[12.5px] text-parchment/80 mb-1">
                Open your browser settings to unblock, then return.
              </p>
              <p className="text-[12px] text-faded">
                សូមបើកការជូនដំណឹងក្នុងការកំណត់កម្មវិធីរុករក រួចត្រឡប់មកវិញ។
              </p>
            </div>
          )}

          {state === "dismissing" && (
            <div className="p-8 text-center" data-testid="bellring-dismissing">
              <p className="text-[13.5px] text-parchment/80">
                Returning to Home · ត្រឡប់ទៅទំព័រដើម…
              </p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
