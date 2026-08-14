import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { Bell, ChevronRight } from "lucide-react";
import useBellRingPermission from "@/eduhub/hooks/useBellRingPermission";
import { useAuth } from "@/eduhub/context/AuthContext";
import BellRingGate from "./BellRingGate";

/**
 * BellRingNagCard — v3.1.0
 * Only triggers AFTER student is logged in.
 * Forces the gate open immediately on login until notifications are allowed.
 * Logged-out users see the dashboard freely.
 */
export default function BellRingNagCard() {
  const { pathname } = useLocation();
  const { permission, supported } = useBellRingPermission();
  const { student } = useAuth();
  const [gateOpen, setGateOpen] = useState(false);

  const onHome = pathname === "/" || pathname === "";
  const isLoggedIn = !!student;
  const needsEnable = supported && permission !== "granted";

  // Only force gate open when: on home + logged in + not yet granted
  useEffect(() => {
    if (onHome && isLoggedIn && needsEnable) {
      setGateOpen(true);
    } else {
      setGateOpen(false);
    }
  }, [onHome, isLoggedIn, needsEnable, permission]);

  // Don't render nag card if not logged in or permission already granted
  if (!onHome || !isLoggedIn || !needsEnable) return null;

  return (
    <>
      <motion.button
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, type: "spring", damping: 20 }}
        onClick={() => setGateOpen(true)}
        data-testid="bellring-nag-card"
        className="fixed left-1/2 -translate-x-1/2 top-[72px] lg:top-[84px] z-40 w-[min(560px,calc(100%-16px))] group flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-transform hover:-translate-y-[1px]"
        style={{
          background: "linear-gradient(135deg, rgba(212,168,67,0.22) 0%, rgba(212,168,67,0.08) 100%)",
          border: "1px solid rgba(212,168,67,0.45)",
          boxShadow: "0 12px 32px -10px rgba(212,168,67,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
        }}
      >
        <motion.span
          animate={{ rotate: [0, -12, 12, -6, 6, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 3.5, ease: "easeInOut" }}
          className="grid h-10 w-10 flex-none place-items-center rounded-full"
          style={{
            background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
            boxShadow: "0 6px 14px rgba(212,168,67,0.4), inset 0 1px 0 rgba(255,255,255,0.55)",
          }}
        >
          <Bell className="h-5 w-5 text-ink" strokeWidth={2.4} />
        </motion.span>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-parchment leading-tight">
            Enable notifications to stay updated with your learning progress
          </p>
          <p className="text-[11px] text-parchment/70 leading-tight mt-0.5">
            បើកការជូនដំណឹង ដើម្បីតាមដានការរីកចម្រើនរបស់អ្នក
          </p>
        </div>

        <span
          className="flex-none inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
          style={{
            background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
            boxShadow: "0 4px 12px rgba(212,168,67,0.35), inset 0 1px 0 rgba(255,255,255,0.55)",
          }}
        >
          Enable now
          <ChevronRight className="h-3 w-3" />
        </span>
      </motion.button>

      <BellRingGate
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        redirectOnDeny="/"
      />
    </>
  );
}