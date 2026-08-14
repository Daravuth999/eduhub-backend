/**
 * NotificationBell.jsx — Activity Center™ premium header bell.
 *
 * Live unread badge + shake animation on realtime arrival. Tapping opens the
 * ActivityDrawer (NotificationContext). Distinct from PushNotificationBell,
 * which remains the browser-push opt-in toggle.
 */
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useNotifications } from "../../context/NotificationContext";

export default function NotificationBell() {
  const ctx = useNotifications();
  const [ringing, setRinging] = useState(false);

  useEffect(() => {
    if (!ctx?.lastArrival) return undefined;
    setRinging(true);
    const t = setTimeout(() => setRinging(false), 1200);
    return () => clearTimeout(t);
  }, [ctx?.lastArrival]);

  if (!ctx) return null;
  const { unreadCount, toggleDrawer, drawerOpen } = ctx;
  const hasUnread = unreadCount > 0;

  return (
    <div className="relative inline-flex items-center">
      <style>{`
        @keyframes eduhub-ac-ring {
          0%,100% { transform: rotate(0deg); }
          15% { transform: rotate(14deg); } 30% { transform: rotate(-12deg); }
          45% { transform: rotate(9deg); }  60% { transform: rotate(-6deg); }
          75% { transform: rotate(3deg); }
        }
        @keyframes eduhub-ac-badge-pop {
          0% { transform: scale(0.4); opacity: 0; }
          70% { transform: scale(1.18); }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <button
        onClick={toggleDrawer}
        aria-label={hasUnread ? `Activity Center — ${unreadCount} unread` : "Activity Center"}
        aria-expanded={drawerOpen}
        data-testid="activity-bell-btn"
        className={[
          "relative w-[34px] h-[34px] rounded-[9px] border flex items-center justify-center",
          "transition-colors duration-200",
          drawerOpen
            ? "bg-aurora-cyan/20 border-aurora-cyan/60 text-aurora-cyan"
            : hasUnread
            ? "bg-aurora-magenta/10 border-aurora-magenta/45 text-white hover:bg-aurora-magenta/20"
            : "bg-white/[0.05] border-white/[0.10] text-white/80 hover:bg-aurora-cyan/15 hover:border-aurora-cyan/50",
        ].join(" ")}
      >
        <Bell
          className="w-4 h-4"
          style={ringing ? { animation: "eduhub-ac-ring 0.9s ease-in-out", transformOrigin: "top center" } : undefined}
        />
        {hasUnread && (
          <span
            data-testid="activity-bell-badge"
            className="absolute -top-[5px] -right-[5px] min-w-[16px] h-[16px] px-[3px] rounded-full bg-aurora-magenta text-white text-[9.5px] font-bold flex items-center justify-center ring-2 ring-[#0a0a0f] leading-none"
            style={{ animation: "eduhub-ac-badge-pop 0.35s ease-out" }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
    </div>
  );
}
