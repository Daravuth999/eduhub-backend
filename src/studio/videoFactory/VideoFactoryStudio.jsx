/**
 * VideoFactoryStudio.jsx — Author Studio's Video Factory: the production
 * hub for Video Library lessons. A lesson library (cards with stage +
 * status chips) opens each lesson's full-screen Production Studio (staged
 * workflow: Info → Media → AI Processing → Sync Review → Teleprompter →
 * Publishing → Analytics). Purchase reconciliation stays surfaced here.
 */
import { useCallback, useEffect, useState } from "react";
import { Video, RefreshCw, Plus, Film, X, Loader2 } from "lucide-react";
import { listLessonsAdmin, createLesson } from "./videoLibraryApi";
import { stageStatus, currentStage, STAGES } from "./productionStages";
import ProductionStudio from "./ProductionStudio";
import ReconcileQueue from "./ReconcileQueue";

const GOLD = "#D4A843";
const TIERS = ["standard", "premium"];
const CATEGORIES = ["", "conversation", "storytelling", "business", "pronunciation", "grammar", "vocabulary", "ielts", "listening", "speaking"];
const DIFFICULTIES = ["", "beginner", "intermediate", "advanced"];
const CEFR_LEVELS = ["", "A1", "A2", "B1", "B2", "C1", "C2"];
const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "published", label: "Published" },
  { key: "archived", label: "Archived" },
];

const inputCls = "rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment placeholder:text-white/25 w-full";

/* ── Create-lesson modal ──────────────────────────────────────────────── */
function CreateModal({ onCreated, onClose }) {
  const [form, setForm] = useState({
    title: "", subtitle: "", description: "", price: "0", tier: "standard",
    instructor: "", category: "", difficulty: "", cefrLevel: "", estimatedStudyMinutes: "", tags: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const handleCreate = async () => {
    setErr(null);
    if (!form.title.trim()) { setErr("Title is required."); return; }
    setSaving(true);
    try {
      const lesson = await createLesson({
        title: form.title.trim(),
        subtitle: form.subtitle.trim(),
        description: form.description.trim(),
        price: Math.max(0, Math.floor(Number(form.price) || 0)),
        tier: form.tier,
        instructor: form.instructor.trim(),
        category: form.category || null,
        difficulty: form.difficulty || null,
        cefrLevel: form.cefrLevel || null,
        estimatedStudyMinutes: Math.max(0, Math.floor(Number(form.estimatedStudyMinutes) || 0)),
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onCreated(lesson);
    } catch (e) {
      setErr(e.message || "Create failed.");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[195] flex items-center justify-center p-4 bg-black/70"
         data-testid="video-factory-create-modal"
         onClick={onClose}
         onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 p-5 space-y-3"
           style={{ background: "#161020" }}
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-parchment flex items-center gap-2">
            <Plus size={14} /> New video lesson
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-faded" aria-label="Close"><X size={15} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-faded sm:col-span-2">Title
            <input value={form.title} onChange={set("title")} placeholder="Ordering Coffee — Conversation Lesson"
                   data-testid="video-factory-new-title-input" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Subtitle (optional)
            <input value={form.subtitle} onChange={set("subtitle")} data-testid="video-factory-new-subtitle-input" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Instructor (optional)
            <input value={form.instructor} onChange={set("instructor")} data-testid="video-factory-new-instructor-input" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded sm:col-span-2">Description (optional)
            <textarea value={form.description} onChange={set("description")} rows={2}
                      data-testid="video-factory-new-description-input" className={`${inputCls} resize-none`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Price (EduHub Points, 0 = free)
            <input type="number" min="0" value={form.price} onChange={set("price")}
                   data-testid="video-factory-new-price-input" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Tier
            <select value={form.tier} onChange={set("tier")} data-testid="video-factory-new-tier-select" className={inputCls}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Category
            <select value={form.category} onChange={set("category")} data-testid="video-factory-new-category-select" className={inputCls}>
              {CATEGORIES.map((c) => <option key={c || "none"} value={c}>{c || "— none —"}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Difficulty
            <select value={form.difficulty} onChange={set("difficulty")} data-testid="video-factory-new-difficulty-select" className={inputCls}>
              {DIFFICULTIES.map((d) => <option key={d || "none"} value={d}>{d || "— none —"}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">CEFR level
            <select value={form.cefrLevel} onChange={set("cefrLevel")} data-testid="video-factory-new-cefr-select" className={inputCls}>
              {CEFR_LEVELS.map((c) => <option key={c || "none"} value={c}>{c || "— none —"}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">Study time (minutes)
            <input type="number" min="0" value={form.estimatedStudyMinutes} onChange={set("estimatedStudyMinutes")}
                   data-testid="video-factory-new-study-minutes-input" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded sm:col-span-2">Tags (comma-separated)
            <input value={form.tags} onChange={set("tags")} placeholder="travel, ordering, politeness"
                   data-testid="video-factory-new-tags-input" className={inputCls} />
          </label>
        </div>
        {err && <div className="text-xs text-red-400" data-testid="video-factory-create-error">{err}</div>}
        <button onClick={handleCreate} disabled={saving}
                data-testid="video-factory-create-button"
                className="w-full rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black text-sm font-semibold px-4 py-2.5 disabled:opacity-50">
          {saving ? "Creating…" : "Create lesson & open production studio"}
        </button>
      </div>
    </div>
  );
}

/* ── Lesson card ──────────────────────────────────────────────────────── */
const STATUS_COLORS = {
  draft: { color: "#9ca3af", border: "rgba(255,255,255,0.15)", bg: "rgba(255,255,255,0.04)" },
  published: { color: "#6ee7b7", border: "rgba(52,211,153,0.4)", bg: "rgba(52,211,153,0.08)" },
  archived: { color: "#fbbf24", border: "rgba(245,158,11,0.4)", bg: "rgba(245,158,11,0.08)" },
};

function LessonProductionCard({ lesson, onOpen }) {
  const statuses = stageStatus(lesson, null);
  const stageKey = currentStage(statuses);
  const stageDef = STAGES.find((s) => s.key === stageKey);
  const sc = STATUS_COLORS[lesson.status] || STATUS_COLORS.draft;
  const pipelineRunning = lesson.pipeline?.state === "running";
  return (
    <button onClick={() => onOpen(lesson)}
            data-testid={`video-factory-lesson-${lesson.lessonId}`}
            className="group text-left rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden hover:border-amber-400/30 transition-colors">
      <div className="relative aspect-video bg-black/40">
        {lesson.thumbnailUrl
          ? <img src={lesson.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center"><Film size={20} className="text-white/20" /></div>}
        <span className="absolute top-1.5 left-1.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border"
              style={{ color: sc.color, borderColor: sc.border, background: "rgba(0,0,0,0.6)" }}>
          {lesson.status}
        </span>
        {lesson.featured && (
          <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(212,168,67,0.9)", color: "#111" }}>★ Featured</span>
        )}
      </div>
      <div className="p-2.5 space-y-1.5">
        <div className="text-[12.5px] font-semibold text-parchment line-clamp-1">{lesson.title}</div>
        <div className="text-[10px] text-faded line-clamp-1">
          {[lesson.category, lesson.difficulty, lesson.price > 0 ? `${lesson.price} pts` : "Free"].filter(Boolean).join(" · ")}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-semibold"
             style={{ color: pipelineRunning ? "#FFE19A" : lesson.status === "published" ? "#6ee7b7" : GOLD }}
             data-testid={`video-factory-lesson-${lesson.lessonId}-stage`}>
          {pipelineRunning ? <Loader2 size={10} className="animate-spin" /> : stageDef && <stageDef.Icon size={10} />}
          {pipelineRunning ? "AI processing…"
            : lesson.status === "published" ? "Live — view analytics"
              : `Stage: ${stageDef?.label || "—"}`}
        </div>
      </div>
    </button>
  );
}

/* ── Panel ────────────────────────────────────────────────────────────── */
export default function VideoFactoryStudio() {
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [openLesson, setOpenLesson] = useState(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      setLessons(await listLessonsAdmin());
    } catch (e) {
      setErr(e.message || "Failed to load lessons.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const visible = statusFilter ? lessons.filter((l) => l.status === statusFilter) : lessons;

  return (
    <div className="space-y-4" data-testid="video-factory-studio">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Video size={16} className="text-amber-300" />
          <h2 className="text-base font-semibold text-parchment">Video Factory</h2>
          <span className="text-xs text-faded hidden sm:inline">— production studio for Video Library lessons</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} data-testid="video-factory-refresh-button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 hover:bg-black/30 px-3 py-1.5 text-xs text-parchment">
            <RefreshCw size={12} /> Refresh
          </button>
          <button onClick={() => setCreating(true)} data-testid="video-factory-new-button"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black px-3 py-1.5 text-xs font-semibold">
            <Plus size={12} /> New lesson
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <ReconcileQueue />
      </div>

      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button key={f.key || "all"} onClick={() => setStatusFilter(f.key)}
                  data-testid={`video-factory-filter-${f.key || "all"}`}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                    statusFilter === f.key
                      ? "border-amber-400/50 text-amber-300 bg-amber-400/10"
                      : "border-white/10 text-faded hover:text-parchment"
                  }`}>
            {f.label}
          </button>
        ))}
      </div>

      {err && <div className="text-xs text-red-400" data-testid="video-factory-error">{err}</div>}
      {loading ? (
        <div className="text-xs text-faded">Loading lessons…</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center" data-testid="video-factory-empty">
          <Film size={22} className="mx-auto mb-2 text-white/25" />
          <div className="text-[13px] font-semibold text-parchment mb-1">No video lessons yet</div>
          <div className="text-xs text-faded mb-3">Create your first lesson and take it through the production workflow.</div>
          <button onClick={() => setCreating(true)}
                  className="rounded-lg bg-amber-500/90 text-black text-xs font-semibold px-3.5 py-2">
            + Create your first lesson
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="video-factory-lesson-list">
          {visible.map((lesson) => (
            <LessonProductionCard key={lesson.lessonId} lesson={lesson} onOpen={setOpenLesson} />
          ))}
        </div>
      )}

      {creating && (
        <CreateModal onClose={() => setCreating(false)}
                     onCreated={(lesson) => { setCreating(false); refresh(); if (lesson) setOpenLesson(lesson); }} />
      )}

      {openLesson && (
        <ProductionStudio lesson={openLesson}
                          onClose={() => { setOpenLesson(null); refresh(); }}
                          onChanged={refresh} />
      )}
    </div>
  );
}
