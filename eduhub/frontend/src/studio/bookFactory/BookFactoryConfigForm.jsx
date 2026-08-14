/**
 * BookFactoryConfigForm.jsx — Smart / Simple / Precise configuration UI.
 * All three modes resolve to ONE canonical config; resolved values stay visible
 * and editable. Reviewable even when generation is disabled (parent disables
 * the Generate action).
 */
import { Sparkles, Wand2, Sliders, ListChecks } from "lucide-react";
import {
  SECTIONS, LEVELS, PEDAGOGY_PROFILES, MODES, RECIPES, PRONUNCIATION_DEPTHS,
  PARAGRAPH_GUIDANCE, SIMPLE_PRESETS, BACKEND_LIMITS, SMART_INPUT_KEYS,
  applyMode, applySimplePreset, applyRecipe, updateSmartInput, validateConfig,
} from "./bookFactorySchema";
import BookFactoryValueComposer from "./BookFactoryValueComposer";

const field = "w-full rounded-lg bg-walnut/40 border border-gold/20 px-3 py-2 text-[13px] text-parchment focus:border-gold outline-none";
const lbl = "block text-[11px] uppercase tracking-wider text-faded mb-1";

const NumField = ({ label, k, config, set, min = 0, max = 1000 }) => (
  <div>
    <label className={lbl}>{label}</label>
    <input type="number" min={min} max={max} className={field} value={config[k]}
           data-testid={`bf-${k}`}
           onChange={(e) => set(k, parseInt(e.target.value || "0", 10))} />
  </div>
);

export const BookFactoryConfigForm = ({ config, onChange, onGenerate, canGenerate, generating }) => {
  // §HIGH 5: editing a Smart INPUT reactively recomputes the resolved config;
  // editing a derived field directly is an explicit author override.
  const set = (k, v) => {
    if ((config.mode || "smart") === "smart" && SMART_INPUT_KEYS.includes(k)) {
      onChange(updateSmartInput(config, { [k]: v }));
    } else {
      onChange({ ...config, [k]: v });
    }
  };
  const errors = validateConfig(config);
  const hasErrors = Object.keys(errors).length > 0;
  const mode = config.mode || "smart";

  // §HIGH 4: aggregate limits shown before submission.
  const totalChapters = (Number(config.chapterCount) || 0) + (config.includeReviewChapter ? 1 : 0);
  const totalWords = (Number(config.chapterCount) || 0) * (Number(config.maxWordsPerChapter) || 0);
  const perEx = (Number(config.vocabularyPerChapter) || 0) + (Number(config.mcqPerChapter) || 0)
    + (Number(config.fillblankPerChapter) || 0) + (Number(config.speakingPerChapter) || 0);
  const totalExercises = totalChapters * perEx;

  return (
    <div className="space-y-4" data-testid="book-factory-config-form">
      {/* Mode selector */}
      <div className="flex gap-1.5" data-testid="bf-mode-tabs">
        {MODES.map((m) => {
          const Icon = m === "smart" ? Wand2 : m === "simple" ? ListChecks : Sliders;
          const active = mode === m;
          return (
            <button key={m} data-testid={`bf-mode-${m}`} onClick={() => onChange(applyMode(config, m))}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${active ? "bg-gold text-ink" : "border border-gold/30 text-gold"}`}>
              <Icon className="h-3.5 w-3.5" /> {m}
            </button>
          );
        })}
      </div>

      {/* Recipe selector (editable defaults) */}
      <div>
        <label className={lbl}>Recipe (editable default)</label>
        <select className={field} value={config.recipeId || ""} data-testid="bf-recipe"
                onChange={(e) => onChange(applyRecipe(config, e.target.value))}>
          <option value="">— none —</option>
          {RECIPES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className={lbl}>Book title</label>
          <input className={field} value={config.title} data-testid="bf-title"
                 onChange={(e) => set("title", e.target.value)} placeholder="My English Adventures" />
          {errors.title && <p className="text-[11px] text-red-300 mt-1">{errors.title}</p>}
        </div>
        <div>
          <label className={lbl}>Subtitle</label>
          <input className={field} value={config.subtitle} data-testid="bf-subtitle"
                 onChange={(e) => set("subtitle", e.target.value)} />
        </div>
      </div>

      <div>
        <label className={lbl}>Topic / theme</label>
        <input className={field} value={config.topic} data-testid="bf-topic"
               onChange={(e) => set("topic", e.target.value)} placeholder="Daily life in a Cambodian town" />
        {errors.topic && <p className="text-[11px] text-red-300 mt-1">{errors.topic}</p>}
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <div>
          <label className={lbl}>Section</label>
          <select className={field} value={config.section} data-testid="bf-section" onChange={(e) => set("section", e.target.value)}>
            {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>CEFR level</label>
          <select className={field} value={config.level} data-testid="bf-level" onChange={(e) => set("level", e.target.value)}>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <NumField label="Reading minutes" k="readingMinutes" config={config} set={set} min={1} max={180} />
      </div>

      {/* Simple-mode presets */}
      {mode === "simple" && (
        <div className="flex gap-1.5" data-testid="bf-simple-presets">
          {Object.entries(SIMPLE_PRESETS).map(([key, p]) => (
            <button key={key} data-testid={`bf-preset-${key}`} onClick={() => onChange(applySimplePreset(config, key))}
                    className={`rounded-full px-3 py-1.5 text-[11px] font-bold ${config._simplePreset === key ? "bg-gold text-ink" : "border border-gold/30 text-gold"}`}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Resolved values — always visible & editable */}
      <div className="grid sm:grid-cols-3 gap-3" data-testid="bf-resolved-values">
        <NumField label="Chapters" k="chapterCount" config={config} set={set} min={1} max={20} />
        <NumField label="Min words / ch" k="minWordsPerChapter" config={config} set={set} min={50} max={1000} />
        <NumField label="Max words / ch" k="maxWordsPerChapter" config={config} set={set} min={50} max={1000} />
      </div>
      {errors.chapterCount && <p className="text-[11px] text-red-300">{errors.chapterCount}</p>}
      {errors.maxWordsPerChapter && <p className="text-[11px] text-red-300">{errors.maxWordsPerChapter}</p>}

      <div className="grid sm:grid-cols-4 gap-3">
        <NumField label="Dialogue turns" k="dialogueTurnsPerChapter" config={config} set={set} min={0} max={20} />
        <NumField label="Vocabulary" k="vocabularyPerChapter" config={config} set={set} min={0} max={20} />
        <NumField label="MCQ" k="mcqPerChapter" config={config} set={set} min={0} max={10} />
        <NumField label="Fill-blank" k="fillblankPerChapter" config={config} set={set} min={0} max={10} />
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <NumField label="Speaking" k="speakingPerChapter" config={config} set={set} min={0} max={10} />
        <div>
          <label className={lbl}>Paragraph guidance</label>
          <select className={field} value={config.paragraphGuidance} data-testid="bf-paragraphGuidance" onChange={(e) => set("paragraphGuidance", e.target.value)}>
            {PARAGRAPH_GUIDANCE.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Pronunciation depth</label>
          <select className={field} value={config.pronunciationDepth} data-testid="bf-pronunciationDepth" onChange={(e) => set("pronunciationDepth", e.target.value)}>
            {PRONUNCIATION_DEPTHS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-parchment/90">
        <input type="checkbox" checked={config.includeReviewChapter} data-testid="bf-review-chapter"
               onChange={(e) => set("includeReviewChapter", e.target.checked)} />
        Add an optional review chapter
      </label>

      <div>
        <label className={lbl}>Pedagogy profile</label>
        <select className={field} value={config.pedagogyProfile} data-testid="bf-pedagogy" onChange={(e) => set("pedagogyProfile", e.target.value)}>
          {PEDAGOGY_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <p className="text-[11px] text-faded mt-1">
          {PEDAGOGY_PROFILES.find((p) => p.id === config.pedagogyProfile)?.description}
        </p>
      </div>

      <BookFactoryValueComposer config={config} onChange={onChange} />

      {/* §HIGH 4: aggregate limits summary (backend remains authoritative). */}
      <div className="rounded-lg border border-gold/15 bg-black/20 p-2.5 text-[11px] text-faded" data-testid="bf-aggregate-limits">
        <span data-testid="bf-agg-chapters">Chapters: {totalChapters}/{BACKEND_LIMITS.maxTotalChapters}</span>
        <span className="mx-2">·</span>
        <span data-testid="bf-agg-words">Words: {totalWords}/{BACKEND_LIMITS.maxTotalWords}</span>
        <span className="mx-2">·</span>
        <span data-testid="bf-agg-exercises">Exercises: {totalExercises}/{BACKEND_LIMITS.maxTotalExercises}</span>
        {errors.exercises && <p className="text-red-300 mt-1" data-testid="bf-agg-error">{errors.exercises}</p>}
      </div>

      <button data-testid="bf-generate-btn" disabled={!canGenerate || generating || hasErrors} onClick={onGenerate}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
        <Sparkles className="h-4 w-4" /> {generating ? "Generating…" : "Generate draft"}
      </button>
    </div>
  );
};

export default BookFactoryConfigForm;
