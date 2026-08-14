/**
 * PublishPanel.jsx — Publishing stage: the lesson's full lifecycle
 * (Draft → Processing → Pending Review → Approved → Published → Archived)
 * visualized from the REAL lesson + sync documents, the pre-publish
 * checklist, and the publish/unpublish/feature/delete actions. The backend
 * enforces every gate (media required, approved sync required) — this
 * panel surfaces those gates before the button is even pressed.
 */
import { useState } from "react";
import { Eye, EyeOff, Star, Trash2, Loader2, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import { publishLesson, unpublishLesson, updateLesson, deleteLesson } from "../videoLibraryApi";

const GOLD = "#D4A843";

function lifecycleStage(lesson, sync) {
  if (lesson.status === "published") return "published";
  if (lesson.status === "archived") return "archived";
  if (sync?.reviewStatus === "approved") return "approved";
  if (lesson.pipeline?.state === "running") return "processing";
  if (sync && sync.alignmentStatus === "complete") return "pending_review";
  return "draft";
}

const LIFECYCLE = [
  { key: "draft", label: "Draft" },
  { key: "processing", label: "Processing" },
  { key: "pending_review", label: "Pending Review" },
  { key: "approved", label: "Approved" },
  { key: "published", label: "Published" },
];

export default function PublishPanel({ lesson, sync, onChanged, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const stage = lifecycleStage(lesson, sync);
  const stageIdx = LIFECYCLE.findIndex((s) => s.key === stage);
  const hasMedia = Boolean(lesson.mediaRef);
  const syncApproved = !sync || sync.alignmentStatus !== "complete" || sync.reviewStatus === "approved";
  const canPublish = hasMedia && syncApproved && lesson.status !== "published";

  const action = async (fn, failMsg) => {
    setErr(null);
    setBusy(true);
    try { await fn(); onChanged(); }
    catch (ex) { setErr(ex.message || failMsg); }
    finally { setBusy(false); }
  };

  const handleDelete = () => {
    if (!window.confirm(`Delete "${lesson.title}"? This cannot be undone.`)) return;
    action(async () => { await deleteLesson(lesson.lessonId); onDeleted?.(); }, "Delete failed.");
  };

  const checks = [
    { label: "Lesson information complete", ok: Boolean(lesson.title && (lesson.category || lesson.difficulty)) },
    { label: "Media uploaded", ok: hasMedia },
    { label: "Thumbnail set", ok: Boolean(lesson.thumbnailUrl) },
    { label: "AI processing complete", ok: lesson.pipeline?.state === "complete" },
    { label: "Synchronization approved in Review Studio", ok: Boolean(sync && sync.reviewStatus === "approved") },
  ];

  return (
    <div className="space-y-5" data-testid="production-publish-panel">
      {/* Lifecycle rail */}
      <div className="flex items-center gap-1 flex-wrap" data-testid="publish-lifecycle">
        {LIFECYCLE.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1">
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full border"
                  data-testid={`lifecycle-${s.key}`}
                  style={i < stageIdx ? { color: "#6ee7b7", borderColor: "rgba(52,211,153,0.35)", background: "rgba(52,211,153,0.08)" }
                    : i === stageIdx ? { color: GOLD, borderColor: "rgba(212,168,67,0.5)", background: "rgba(212,168,67,0.12)" }
                      : { color: "rgba(255,255,255,0.3)", borderColor: "rgba(255,255,255,0.1)" }}>
              {s.label}
            </span>
            {i < LIFECYCLE.length - 1 && <ChevronRight size={11} className="text-white/20" />}
          </div>
        ))}
        {stage === "archived" && (
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full border"
                style={{ color: "#fbbf24", borderColor: "rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.1)" }}>
            Archived
          </span>
        )}
      </div>

      {/* Pre-publish checklist */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-2" data-testid="publish-checklist">
        <div className="text-[11px] font-bold uppercase tracking-wider text-faded mb-1">Release checklist</div>
        {checks.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-[12px]">
            {c.ok ? <CheckCircle2 size={13} className="text-emerald-300" /> : <XCircle size={13} className="text-white/25" />}
            <span style={{ color: c.ok ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)" }}>{c.label}</span>
          </div>
        ))}
        <div className="text-[10.5px] text-faded pt-1">
          The backend enforces media + approved synchronization at publish time; thumbnail and analysis are recommended, not blocking.
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => action(
            () => lesson.status === "published" ? unpublishLesson(lesson.lessonId) : publishLesson(lesson.lessonId),
            "Update failed.",
          )}
          disabled={busy || (lesson.status !== "published" && !hasMedia)}
          data-testid="publish-toggle-button"
          className="inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold px-4 py-2 disabled:opacity-40"
          style={lesson.status === "published"
            ? { border: "1px solid rgba(255,255,255,0.15)", color: "#e5e5e5" }
            : { background: GOLD, color: "#111" }}>
          {busy ? <Loader2 size={13} className="animate-spin" />
            : lesson.status === "published" ? <EyeOff size={13} /> : <Eye size={13} />}
          {lesson.status === "published" ? "Unpublish" : "Publish lesson"}
        </button>
        <button onClick={() => action(() => updateLesson(lesson.lessonId, { featured: !lesson.featured }), "Update failed.")}
                disabled={busy}
                data-testid="publish-featured-toggle"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-parchment disabled:opacity-40">
          <Star size={12} style={lesson.featured ? { color: "#FFE19A", fill: "#FFE19A" } : undefined} />
          {lesson.featured ? "Unfeature" : "Feature on dashboard"}
        </button>
        <button onClick={handleDelete} disabled={busy || lesson.status === "published"}
                title={lesson.status === "published" ? "Unpublish before deleting" : undefined}
                data-testid="publish-delete-button"
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300 disabled:opacity-40">
          <Trash2 size={12} /> Delete lesson
        </button>
      </div>

      {!canPublish && lesson.status !== "published" && (
        <div className="text-[11.5px] text-amber-300/80" data-testid="publish-blocked-hint">
          {!hasMedia ? "Upload media before publishing."
            : !syncApproved ? "Approve this lesson's synchronization in the Review Studio before publishing." : ""}
        </div>
      )}
      {err && <div className="text-xs text-red-400" data-testid="publish-error">{err}</div>}
    </div>
  );
}
