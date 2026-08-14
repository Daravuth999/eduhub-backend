/**
 * ActivityTimeline.jsx — Today / Yesterday / Older grouped notification list.
 * Renders real events only. Tapping an unread item marks it read; internal
 * URLs navigate via react-router.
 */
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import { categoryIcon, groupByDay, priorityStyle, relativeTime } from "./activityTheme";

function TimelineItem({ item, onOpen }) {
  const pri = priorityStyle(item.priority);
  const Icon = categoryIcon(item.category, item.priority);
  return (
    <button
      onClick={() => onOpen(item)}
      data-testid={`activity-item-${item.id}`}
      className={[
        "w-full text-left flex items-start gap-3 px-3 py-3 rounded-xl border transition-colors duration-150",
        item.read
          ? "bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05]"
          : "border-transparent hover:brightness-110",
      ].join(" ")}
      style={item.read ? undefined : { background: pri.bg, borderColor: pri.ring }}
    >
      <span
        className="mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: pri.bg, border: `1px solid ${pri.ring}` }}
      >
        <Icon className="w-4 h-4" style={{ color: pri.accent }} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className={`text-[12.5px] font-semibold truncate ${item.read ? "text-white/70" : "text-white"}`}>
            {item.title}
          </span>
          {item.priority !== "normal" && (
            <span
              className="shrink-0 text-[8.5px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded-full"
              style={{ color: pri.accent, background: pri.bg, border: `1px solid ${pri.ring}` }}
            >
              {pri.label}
            </span>
          )}
        </span>
        <span className={`block text-[11.5px] mt-0.5 line-clamp-2 ${item.read ? "text-white/40" : "text-white/65"}`}>
          {item.body}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1.5 shrink-0 ml-1">
        <span className="text-[10px] text-white/35 tabular-nums">{relativeTime(item.createdAt)}</span>
        {!item.read && (
          <span
            data-testid={`activity-unread-dot-${item.id}`}
            className="w-2 h-2 rounded-full"
            style={{ background: pri.accent, boxShadow: `0 0 6px ${pri.accent}` }}
          />
        )}
      </span>
    </button>
  );
}

export default function ActivityTimeline({ items }) {
  const { markRead, closeDrawer } = useNotifications();
  const navigate = useNavigate();

  const onOpen = (item) => {
    if (!item.read) markRead(item.id);
    const url = item.url || "";
    if (url && url.startsWith("/") && url !== "/") {
      closeDrawer();
      navigate(url);
    }
  };

  const buckets = groupByDay(items);
  return (
    <div className="space-y-4" data-testid="activity-timeline">
      {["Today", "Yesterday", "Older"].map((label) =>
        buckets[label].length ? (
          <section key={label}>
            <h4 className="px-1 mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/35">
              {label}
            </h4>
            <div className="space-y-1.5">
              {buckets[label].map((item) => (
                <TimelineItem key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}
