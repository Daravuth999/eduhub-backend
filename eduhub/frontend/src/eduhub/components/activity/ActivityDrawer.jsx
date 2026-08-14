/**
 * ActivityDrawer.jsx — Activity Center™ slide-down drawer.
 *
 * Opens from the header bell. Mobile-first full-width sheet; on ≥sm it
 * anchors to the right as a 400 px panel. Category tabs, Cathy insight
 * section, Today/Yesterday/Older timeline, mark-all-read, load-more.
 * All content is real backend activity — the empty state simply says so.
 */
import { CheckCheck, Inbox, Loader2, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNotifications } from "../../context/NotificationContext";
import ActivityTimeline from "./ActivityTimeline";
import CathyInsight from "./CathyInsight";
import { CATEGORY_META, CATEGORY_ORDER } from "./activityTheme";

export default function ActivityDrawer() {
  const ctx = useNotifications();
  const [tab, setTab] = useState("all");
  const open = Boolean(ctx?.drawerOpen);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && ctx.closeDrawer();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ctx]);

  const filtered = useMemo(() => {
    const items = ctx?.items || [];
    return tab === "all" ? items : items.filter((n) => n.category === tab);
  }, [ctx?.items, tab]);

  if (!ctx) return null;
  const { closeDrawer, markAllRead, unreadCount, hasMore, loadMore, loading, wsConnected } = ctx;

  return (
    <div
      className={`fixed inset-0 z-[300] ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
      data-testid="activity-drawer-root"
    >
      {/* backdrop */}
      <div
        onClick={closeDrawer}
        data-testid="activity-drawer-backdrop"
        className={`absolute inset-0 bg-black/55 backdrop-blur-[2px] transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
      />
      {/* panel */}
      <div
        role="dialog"
        aria-label="Activity Center"
        data-testid="activity-drawer-panel"
        className={[
          "absolute left-0 right-0 sm:left-auto sm:right-3 top-0 sm:top-[64px]",
          "w-full sm:w-[400px] sm:rounded-2xl overflow-hidden",
          "border-b sm:border border-white/[0.10] shadow-2xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "-translate-y-[110%]",
        ].join(" ")}
        style={{
          background: "rgba(12,6,28,0.96)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          maxHeight: "min(78vh, 640px)",
          paddingTop: "env(safe-area-inset-top)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-white/[0.07] shrink-0">
          <h3 className="text-[14px] font-bold text-white tracking-tight">Activity</h3>
          {unreadCount > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-[1px] rounded-full bg-aurora-magenta/20 text-aurora-magenta border border-aurora-magenta/40">
              {unreadCount} new
            </span>
          )}
          <span
            title={wsConnected ? "Live" : "Reconnecting…"}
            className={`ml-1 inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider ${wsConnected ? "text-emerald-400" : "text-white/25"}`}
            data-testid="activity-live-indicator"
          >
            <Wifi className="w-3 h-3" />
            {wsConnected ? "Live" : ""}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                data-testid="activity-mark-all-read-btn"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10.5px] font-semibold text-aurora-cyan bg-aurora-cyan/10 border border-aurora-cyan/30 hover:bg-aurora-cyan/20 transition-colors"
              >
                <CheckCheck className="w-3 h-3" />
                Mark all read
              </button>
            )}
            <button
              onClick={closeDrawer}
              aria-label="Close"
              data-testid="activity-drawer-close-btn"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 bg-white/[0.05] border border-white/[0.10] hover:bg-white/[0.12] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* tabs */}
        <div className="flex gap-1.5 px-3 py-2 overflow-x-auto shrink-0 [-webkit-overflow-scrolling:touch] [scrollbar-width:none]">
          {CATEGORY_ORDER.map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              data-testid={`activity-tab-${key}`}
              className={[
                "shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold transition-colors border",
                tab === key
                  ? "bg-aurora-violet/25 border-aurora-violet/60 text-white"
                  : "bg-white/[0.04] border-white/[0.08] text-white/55 hover:text-white/85",
              ].join(" ")}
            >
              {CATEGORY_META[key].label}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-3 pb-4 pt-1 overscroll-contain">
          {tab === "all" && <CathyInsight items={ctx.items} />}
          {loading && !filtered.length ? (
            <div className="flex items-center justify-center py-12 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : filtered.length ? (
            <>
              <ActivityTimeline items={filtered} />
              {hasMore && tab === "all" && (
                <button
                  onClick={loadMore}
                  data-testid="activity-load-more-btn"
                  className="mt-3 w-full py-2 rounded-xl text-[11.5px] font-semibold text-white/60 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-colors"
                >
                  Load older activity
                </button>
              )}
            </>
          ) : (
            <div
              className="flex flex-col items-center justify-center py-14 text-center"
              data-testid="activity-empty-state"
            >
              <span className="w-12 h-12 rounded-2xl flex items-center justify-center bg-white/[0.04] border border-white/[0.08] mb-3">
                <Inbox className="w-5 h-5 text-white/30" />
              </span>
              <p className="text-[12.5px] font-semibold text-white/60">No activity yet</p>
              <p className="text-[11px] text-white/35 mt-1 max-w-[240px]">
                Points, rewards, payments and class updates will appear here as they happen.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
