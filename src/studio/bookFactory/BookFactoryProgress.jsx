/**
 * BookFactoryProgress.jsx — live stepper showing blueprint + per-chapter
 * states while generation runs. Read-only; addressed by stable chapterId.
 */
import { CheckCircle2, Loader2, AlertTriangle, Circle, HelpCircle } from "lucide-react";

const STATE_META = {
  pending: { Icon: Circle, color: "#9a8fb0", label: "Pending" },
  claimed: { Icon: Loader2, color: "#D4A843", label: "Working", spin: true },
  provider_pending: { Icon: Loader2, color: "#D4A843", label: "Generating", spin: true },
  completed: { Icon: CheckCircle2, color: "#7fd18b", label: "Done" },
  failed_retryable: { Icon: AlertTriangle, color: "#e0a84b", label: "Retryable" },
  failed_terminal: { Icon: AlertTriangle, color: "#e06b6b", label: "Failed" },
  unknown_outcome: { Icon: HelpCircle, color: "#c98bd1", label: "Unknown" },
};

function Row({ label, state }) {
  const meta = STATE_META[state] || STATE_META.pending;
  const { Icon } = meta;
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5"
         data-testid={`bf-progress-row`} data-state={state}>
      <span className="text-[12.5px] text-parchment/90 truncate">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: meta.color }}>
        <Icon className={`h-3.5 w-3.5 ${meta.spin ? "animate-spin" : ""}`} /> {meta.label}
      </span>
    </div>
  );
}

export const BookFactoryProgress = ({ job }) => {
  if (!job) return null;
  const order = job.chapterOrder || [];
  const chapters = job.chapters || {};
  return (
    <div className="rounded-xl border border-gold/15 bg-walnut/20 p-4" data-testid="book-factory-progress">
      <p className="text-[11px] uppercase tracking-wider text-gold/80 mb-2">Generation progress</p>
      <Row label="Blueprint" state={job.blueprint?.state || "pending"} />
      {order.map((cid) => (
        <Row key={cid} label={chapters[cid]?.title || cid} state={chapters[cid]?.state || "pending"} />
      ))}
    </div>
  );
};

export default BookFactoryProgress;
