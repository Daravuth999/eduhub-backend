/**
 * InfoPanel.jsx — Lesson Information stage: the full editable metadata form
 * (title, subtitle, description, taxonomy, pricing, tags, thumbnail
 * preview). Edits PATCH the real lesson document via the existing
 * /studio/video/lessons/{id} route.
 */
import { useState } from "react";
import { Save, Loader2, Tag } from "lucide-react";
import { updateLesson } from "../videoLibraryApi";

const CATEGORIES = ["", "conversation", "storytelling", "business", "pronunciation", "grammar", "vocabulary", "ielts", "listening", "speaking"];
const DIFFICULTIES = ["", "beginner", "intermediate", "advanced"];
const CEFR_LEVELS = ["", "A1", "A2", "B1", "B2", "C1", "C2"];
const TIERS = ["standard", "premium"];

const inputCls = "rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full focus:outline-none focus:border-amber-400/40";

function Field({ label, children, span }) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-faded ${span ? "sm:col-span-2" : ""}`}>
      {label}
      {children}
    </label>
  );
}

export default function InfoPanel({ lesson, onChanged }) {
  const [form, setForm] = useState({
    title: lesson.title || "",
    subtitle: lesson.subtitle || "",
    description: lesson.description || "",
    instructor: lesson.instructor || "",
    category: lesson.category || "",
    difficulty: lesson.difficulty || "",
    cefrLevel: lesson.cefrLevel || "",
    estimatedStudyMinutes: String(lesson.estimatedStudyMinutes || ""),
    price: String(lesson.price ?? 0),
    tier: lesson.tier || "standard",
    tags: (lesson.tags || []).join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const handleSave = async () => {
    setErr(null);
    if (!form.title.trim()) { setErr("Title is required."); return; }
    setSaving(true);
    try {
      await updateLesson(lesson.lessonId, {
        title: form.title.trim(),
        subtitle: form.subtitle.trim(),
        description: form.description.trim(),
        instructor: form.instructor.trim(),
        category: form.category || null,
        difficulty: form.difficulty || null,
        cefrLevel: form.cefrLevel || null,
        estimatedStudyMinutes: Math.max(0, Math.floor(Number(form.estimatedStudyMinutes) || 0)),
        price: Math.max(0, Math.floor(Number(form.price) || 0)),
        tier: form.tier,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="production-info-panel">
      <div className="flex gap-4 items-start">
        <div className="w-40 aspect-video rounded-lg overflow-hidden bg-black/30 border border-white/10 flex items-center justify-center flex-shrink-0">
          {lesson.thumbnailUrl
            ? <img src={lesson.thumbnailUrl} alt="" className="w-full h-full object-cover" />
            : <span className="text-[10px] text-faded text-center px-2">Thumbnail set in the Media stage</span>}
        </div>
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Title" span>
            <input value={form.title} onChange={set("title")} data-testid="info-title-input" className={inputCls} />
          </Field>
          <Field label="Subtitle">
            <input value={form.subtitle} onChange={set("subtitle")} data-testid="info-subtitle-input" className={inputCls} />
          </Field>
          <Field label="Instructor">
            <input value={form.instructor} onChange={set("instructor")} data-testid="info-instructor-input" className={inputCls} />
          </Field>
        </div>
      </div>

      <Field label="Description — what students will learn" span>
        <textarea value={form.description} onChange={set("description")} rows={3}
                  data-testid="info-description-input"
                  placeholder="A short, student-facing description of this lesson…"
                  className={`${inputCls} resize-none`} />
      </Field>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Category">
          <select value={form.category} onChange={set("category")} data-testid="info-category-select" className={inputCls}>
            {CATEGORIES.map((c) => <option key={c || "none"} value={c}>{c || "— none —"}</option>)}
          </select>
        </Field>
        <Field label="Difficulty">
          <select value={form.difficulty} onChange={set("difficulty")} data-testid="info-difficulty-select" className={inputCls}>
            {DIFFICULTIES.map((d) => <option key={d || "none"} value={d}>{d || "— none —"}</option>)}
          </select>
        </Field>
        <Field label="CEFR level">
          <select value={form.cefrLevel} onChange={set("cefrLevel")} data-testid="info-cefr-select" className={inputCls}>
            {CEFR_LEVELS.map((c) => <option key={c || "none"} value={c}>{c || "— none —"}</option>)}
          </select>
        </Field>
        <Field label="Study time (min)">
          <input type="number" min="0" value={form.estimatedStudyMinutes} onChange={set("estimatedStudyMinutes")}
                 data-testid="info-study-minutes-input" className={inputCls} />
        </Field>
        <Field label="Price (EduHub Points, 0 = free)">
          <input type="number" min="0" value={form.price} onChange={set("price")}
                 data-testid="info-price-input" className={inputCls} />
        </Field>
        <Field label="Tier">
          <select value={form.tier} onChange={set("tier")} data-testid="info-tier-select" className={inputCls}>
            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Tags (comma-separated)" span>
          <div className="relative">
            <Tag size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faded" />
            <input value={form.tags} onChange={set("tags")} data-testid="info-tags-input"
                   placeholder="travel, ordering, politeness"
                   className={`${inputCls} pl-8`} />
          </div>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
                data-testid="info-save-button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black text-sm font-semibold px-4 py-2 disabled:opacity-50">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save lesson info
        </button>
        {savedAt && !saving && <span className="text-[11px] text-emerald-300">Saved ✓</span>}
        {err && <span className="text-xs text-red-400" data-testid="info-error">{err}</span>}
      </div>
    </div>
  );
}
