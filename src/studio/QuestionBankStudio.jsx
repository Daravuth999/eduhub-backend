/**
 * QuestionBankStudio.jsx — Author Studio's "Question Bank" screen
 * (architecture.md continuation: "Question Bank: categories/search/
 * import/export/versioning/publish, moved into Author Studio"). Replaces
 * the Speaking Lab Console's localStorage-backed question editor with a
 * real, versioned Mongo-backed store — categories are free-form (not
 * limited to the legacy beginner/intermediate split), search filters by
 * text, and import accepts either the new shape or the legacy flat
 * ``{"beginner": [...], "intermediate": [...]}`` shape so nothing already
 * authored is lost.
 *
 * Backend: question_bank.py, mounted at /api/v1/question-bank*.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpen, RefreshCw, Search, Trash2, Upload, Download, Save } from "lucide-react";
import {
  listQuestions, listQuestionCategories, createQuestion, updateQuestion,
  publishQuestion, unpublishQuestion, archiveQuestion, deleteQuestion,
  importQuestions, exportQuestions,
} from "./api";

function Badge({ children, color = "muted" }) {
  const colors = {
    gold:  { bg: "rgba(212,168,67,0.15)",  border: "rgba(212,168,67,0.4)",  text: "#FFE19A" },
    green: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)", text: "#6ee7b7" },
    blue:  { bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.3)",  text: "#93c5fd" },
    muted: { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)", text: "#9ca3af" },
  };
  const c = colors[color] || colors.muted;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {children}
    </span>
  );
}

const STATUS_COLOR = { draft: "muted", published: "green", archived: "blue" };

/* ── Create-question form ─────────────────────────────────────────────── */
function CreateForm({ onCreated }) {
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleCreate = async () => {
    setErr(null);
    setSaving(true);
    try {
      await createQuestion({
        category: category.trim(),
        text: text.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setCategory(""); setText(""); setTags("");
      onCreated();
    } catch (e) {
      setErr(e.message || "Create failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-parchment">Add a question</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded">
          Category
          <input value={category} onChange={(e) => setCategory(e.target.value)}
                 placeholder="beginner"
                 data-testid="question-bank-new-category-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded sm:col-span-2">
          Question text
          <input value={text} onChange={(e) => setText(e.target.value)}
                 placeholder="What is your favorite hobby?"
                 data-testid="question-bank-new-text-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-faded">
        Tags (comma-separated, optional)
        <input value={tags} onChange={(e) => setTags(e.target.value)}
               data-testid="question-bank-new-tags-input"
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </label>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <button disabled={saving} onClick={handleCreate}
              data-testid="question-bank-create-button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
        <Save className="h-3.5 w-3.5" /> {saving ? "Adding…" : "Add question"}
      </button>
    </div>
  );
}

/* ── Import / Export panel ────────────────────────────────────────────── */
function ImportExportPanel({ onImported }) {
  const [raw, setRaw] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const handleImport = async () => {
    setErr(null);
    setResult(null);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      setErr("Not valid JSON. Paste either {\"items\": [...]} or the legacy {\"beginner\": [...]} shape.");
      return;
    }
    setImporting(true);
    try {
      const res = await importQuestions(payload);
      setResult(res);
      setRaw("");
      onImported();
    } catch (e) {
      setErr(e.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async () => {
    setErr(null);
    try {
      const data = await exportQuestions();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "question-bank-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e.message || "Export failed.");
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-parchment">Import / Export</div>
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
                placeholder='{"items": [{"category": "beginner", "text": "..."}]}  — or the legacy {"beginner": [...], "intermediate": [...]} shape'
                data-testid="question-bank-import-textarea"
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs font-mono text-parchment" />
      {err && <div className="text-xs text-red-400">{err}</div>}
      {result && (
        <div className="text-xs text-faded" data-testid="question-bank-import-result">
          Imported {result.imported}, skipped {result.skipped}.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={importing || !raw.trim()} onClick={handleImport}
                data-testid="question-bank-import-button"
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          <Upload className="h-3.5 w-3.5" /> {importing ? "Importing…" : "Import"}
        </button>
        <button onClick={handleExport}
                data-testid="question-bank-export-button"
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-faded hover:text-parchment hover:bg-white/10">
          <Download className="h-3.5 w-3.5" /> Export all
        </button>
      </div>
    </div>
  );
}

/* ── Edit form (inline, draft-only) ───────────────────────────────────── */
function EditForm({ question, onSaved, onCancel }) {
  const [text, setText] = useState(question.text);
  const [category, setCategory] = useState(question.category);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      await updateQuestion(question._id, { text: text.trim(), category: category.trim() });
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <input value={category} onChange={(e) => setCategory(e.target.value)}
             data-testid={`question-bank-edit-category-${question._id}`}
             className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full" />
      <input value={text} onChange={(e) => setText(e.target.value)}
             data-testid={`question-bank-edit-text-${question._id}`}
             className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full" />
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSave}
                data-testid={`question-bank-save-${question._id}`}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Question row ─────────────────────────────────────────────────────── */
function QuestionRow({ question, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (fn) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`question-bank-row-${question._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge color="gold">{question.category}</Badge>
          <Badge color={STATUS_COLOR[question.status] || "muted"}>{question.status}</Badge>
          <span className="text-xs text-faded">v{question.version ?? 1}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {question.status === "draft" && (
            <button disabled={busy} onClick={() => setEditing((v) => !v)}
                    data-testid={`question-bank-edit-${question._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Edit
            </button>
          )}
          {question.status !== "published" && question.status !== "archived" && (
            <button disabled={busy} onClick={() => run(() => publishQuestion(question._id))}
                    data-testid={`question-bank-publish-${question._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Publish
            </button>
          )}
          {question.status === "published" && (
            <button disabled={busy} onClick={() => run(() => unpublishQuestion(question._id))}
                    data-testid={`question-bank-unpublish-${question._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Unpublish
            </button>
          )}
          {question.status !== "archived" && (
            <button disabled={busy} onClick={() => run(() => archiveQuestion(question._id))}
                    data-testid={`question-bank-archive-${question._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Archive
            </button>
          )}
          {question.status !== "published" && (
            <button disabled={busy} onClick={() => run(() => deleteQuestion(question._id))}
                    data-testid={`question-bank-delete-${question._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-red-400 hover:bg-red-500/10">
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 text-sm text-parchment">{question.text}</div>
      {(question.tags || []).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {question.tags.map((t) => (
            <span key={t} className="text-[10px] text-faded rounded-full bg-white/5 px-2 py-0.5">{t}</span>
          ))}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {editing && (
        <div className="mt-3">
          <EditForm question={question} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
        </div>
      )}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────── */
export default function QuestionBankStudio() {
  const [questions, setQuestions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [qData, cData] = await Promise.all([
        listQuestions({ category: category || undefined, status: status || undefined, search: search || undefined }),
        listQuestionCategories(),
      ]);
      setQuestions(qData.questions || []);
      setCategories(cData.categories || []);
    } catch (e) {
      setErr(e.message || "Failed to load question bank.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, status, search]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment flex items-center gap-2">
            <BookOpen className="h-5 w-5" /> Question Bank
          </h2>
          <p className="text-xs text-faded">
            Categories, search, import/export, and draft → published → archived versioning — the structured replacement for the old localStorage question editor.
          </p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <CreateForm onCreated={reload} />
      <ImportExportPanel onImported={reload} />

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs text-faded">
            Search
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-faded" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                     data-testid="question-bank-search-input"
                     className="w-full rounded-lg border border-white/10 bg-black/20 pl-8 pr-3 py-2 text-sm text-parchment" />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}
                    data-testid="question-bank-category-filter"
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment">
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.category} value={c.category}>{c.category} ({c.count})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}
                    data-testid="question-bank-status-filter"
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}

      <div>
        <div className="text-sm font-semibold text-parchment mb-2">Questions</div>
        {loading ? (
          <div className="text-sm text-faded">Loading…</div>
        ) : questions.length === 0 ? (
          <div className="text-sm text-faded">No questions match these filters yet.</div>
        ) : (
          <div className="space-y-3">
            {questions.map((q) => (
              <QuestionRow key={q._id} question={q} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
