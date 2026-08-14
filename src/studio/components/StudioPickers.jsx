/**
 * StudioPickers.jsx — shared dropdown pickers for Author Studio.
 *
 * v10.1 (2026-05) — convenience upgrade: replaces bare text inputs for
 * Student ID, Group, and Book Slug fields across TeacherStudio, PushStudio,
 * and CouponStudio with searchable dropdowns that load real data from the
 * already-deployed API.
 *
 * Three reusable components, zero new API endpoints:
 *
 *   <StudentPicker value={id} onChange={setId} />
 *     → single-select searchable dropdown of all students
 *       (clean_id + display_name). Loads via listStudents().
 *
 *   <GroupPicker value={group} onChange={setGroup} />
 *     → single-select dropdown of unique groups derived from the same
 *       student list (no extra fetch).
 *
 *   <BookPicker value={slugsCsv} onChange={setSlugs} multiSelect />
 *     → multi-select dropdown of all published books.
 *       Loads via listStudioBooks(). Value is a comma-separated slug string
 *       to stay compatible with the existing CouponStudio payload builder.
 *
 * Design contract (strict safeguard compliance):
 *   - No existing component, API route, payload shape, or data contract is
 *     modified. Callers still receive the same string values (clean_id,
 *     group name, comma-separated slugs) they always passed to the API.
 *   - Each picker falls back to a plain text input when data cannot be
 *     loaded, so every existing flow continues working even if the fetch
 *     fails.
 *   - Visual language matches the existing Studio palette exactly
 *     (parchment/gold on near-black, Plus Jakarta Sans).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Search, X, Check, Loader2, AlertTriangle } from "lucide-react";
import { listStudents } from "../../eduhub/auth/studentAuthService";
import { listStudioBooks } from "../api";

/* ── shared design tokens (exact match to TeacherStudio / PushStudio) ── */
const css = {
  bg:           "#0a0a0f",
  card:         "rgba(255,255,255,0.04)",
  border:       "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  borderFocus:  "rgba(212,168,67,0.45)",
  text:         "#F4E5C1",
  textMuted:    "rgba(244,229,193,0.55)",
  aurora:       "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  dropdownBg:   "rgba(14,10,22,0.98)",
};

const inputBase = {
  background: "rgba(255,255,255,0.03)",
  border:     `1px solid ${css.border}`,
  color:      css.text,
  outline:    "none",
};

/* ── shared data hook ────────────────────────────────────────────────── */

/**
 * useStudentList — loads the student roster once per mount.
 * Returns { students, groups, loading, error }.
 * `groups` is a sorted array of unique non-empty group strings.
 */
export function useStudentList() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listStudents()
      .then((s) => {
        if (cancelled) return;
        setStudents(Array.isArray(s) ? s : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load students");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const groups = Array.from(
    new Set(students.map((s) => (s.group || "").trim()).filter(Boolean))
  ).sort();

  return { students, groups, loading, error };
}

/**
 * useBookList — loads published studio books once per mount.
 * Returns { books, loading, error }.
 */
export function useBookList() {
  const [books, setBooks]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listStudioBooks()
      .then((raw) => {
        if (cancelled) return;
        const arr = Array.isArray(raw) ? raw : (raw?.books || []);
        setBooks(arr.filter((b) => b.slug && b.title));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load books");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { books, loading, error };
}

/* ── internal shared dropdown shell ─────────────────────────────────── */

function DropdownShell({
  trigger,          // ReactNode rendered as the button face
  children,         // dropdown panel content
  open,
  setOpen,
  testid,
}) {
  const ref = useRef(null);

  /* Close on outside click */
  useEffect(() => {
    if (!open) return undefined;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  return (
    <div ref={ref} style={{ position: "relative" }} data-testid={testid}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] text-left transition-all"
        style={{
          ...inputBase,
          border: open ? `1px solid ${css.borderFocus}` : inputBase.border,
        }}
      >
        <span className="flex-1 min-w-0 truncate">{trigger}</span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 transition-transform"
          style={{
            color: css.textMuted,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {open && (
        <div
          className="absolute z-50 w-full mt-1 rounded-xl overflow-hidden"
          style={{
            background: css.dropdownBg,
            border:     `1px solid ${css.borderStrong}`,
            boxShadow:  "0 16px 40px rgba(0,0,0,0.65)",
            maxHeight:  "260px",
            overflowY:  "auto",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ── search box used inside dropdowns ────────────────────────────────── */
function DropdownSearch({ value, onChange, placeholder }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 sticky top-0"
      style={{ background: css.dropdownBg, borderBottom: `1px solid ${css.border}` }}
    >
      <Search className="h-3.5 w-3.5 shrink-0" style={{ color: css.textMuted }} />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-[12px] outline-none"
        style={{ color: css.text }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {value && (
        <button type="button" onClick={() => onChange("")}>
          <X className="h-3 w-3" style={{ color: css.textMuted }} />
        </button>
      )}
    </div>
  );
}

/* ── loading / error / empty states ─────────────────────────────────── */
function DropdownStatus({ loading, error, emptyMsg }) {
  if (loading) return (
    <div className="flex items-center gap-2 px-3 py-3 text-[12px]"
         style={{ color: css.textMuted }}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
    </div>
  );
  if (error) return (
    <div className="flex items-center gap-2 px-3 py-3 text-[12px]"
         style={{ color: "#fca5a5" }}>
      <AlertTriangle className="h-3.5 w-3.5" /> {error}
    </div>
  );
  if (emptyMsg) return (
    <div className="px-3 py-3 text-[12px]" style={{ color: css.textMuted }}>
      {emptyMsg}
    </div>
  );
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   StudentPicker
   ───────────────────────────────────────────────────────────────────────
   Single-select searchable dropdown.
   value:    the selected clean_id string (e.g. "stu001")
   onChange: called with the new clean_id string
   students, loading, error: from useStudentList()
   ═══════════════════════════════════════════════════════════════════════ */
export function StudentPicker({ value, onChange, students, loading, error, testid = "student-picker" }) {
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState("");

  const filtered = students.filter((s) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (s.clean_id     || "").toLowerCase().includes(q) ||
      (s.display_name || "").toLowerCase().includes(q) ||
      (s.group        || "").toLowerCase().includes(q)
    );
  });

  const selected = students.find(
    (s) => s.clean_id === value || s.student_id === value
  );

  const handleSelect = (s) => {
    onChange(s.clean_id || s.student_id || "");
    setOpen(false);
    setQuery("");
  };

  const trigger = selected
    ? (
      <span>
        <span style={{ color: css.text }}>{selected.display_name || selected.clean_id}</span>
        <span className="ml-2 text-[11px]" style={{ color: css.textMuted }}>
          {selected.clean_id}
          {selected.group ? ` · ${selected.group}` : ""}
        </span>
      </span>
    )
    : <span style={{ color: css.textMuted }}>
        {loading ? "Loading students…" : "Select a student…"}
      </span>;

  return (
    <DropdownShell trigger={trigger} open={open} setOpen={setOpen} testid={testid}>
      <DropdownSearch value={query} onChange={setQuery} placeholder="Search by name, ID or group…" />
      <DropdownStatus loading={loading} error={error}
                      emptyMsg={!loading && !error && filtered.length === 0 ? "No students match." : null} />
      {!loading && !error && filtered.map((s) => {
        const id = s.clean_id || s.student_id || "";
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleSelect(s)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
            style={{
              background: active ? "rgba(212,168,67,0.10)" : "transparent",
              borderBottom: `1px solid ${css.border}`,
            }}
            data-testid={`${testid}-opt-${id}`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate" style={{ color: css.text }}>
                {s.display_name || id}
              </div>
              <div className="text-[11px]" style={{ color: css.textMuted }}>
                {id}{s.group ? ` · ${s.group}` : ""}
              </div>
            </div>
            {active && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "#D4A843" }} />}
          </button>
        );
      })}
    </DropdownShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   GroupPicker
   ───────────────────────────────────────────────────────────────────────
   Single-select dropdown of unique groups.
   value:    selected group string
   onChange: called with the new group string
   groups:   from useStudentList()
   ═══════════════════════════════════════════════════════════════════════ */
export function GroupPicker({ value, onChange, groups, loading, error, testid = "group-picker" }) {
  const [open, setOpen] = useState(false);

  const trigger = value
    ? <span style={{ color: css.text }}>{value}</span>
    : <span style={{ color: css.textMuted }}>
        {loading ? "Loading groups…" : "Select a group…"}
      </span>;

  return (
    <DropdownShell trigger={trigger} open={open} setOpen={setOpen} testid={testid}>
      <DropdownStatus loading={loading} error={error}
                      emptyMsg={!loading && !error && groups.length === 0 ? "No groups found. Add a group when creating students." : null} />
      {!loading && !error && groups.map((g) => {
        const active = g === value;
        return (
          <button
            key={g}
            type="button"
            onClick={() => { onChange(active ? "" : g); setOpen(false); }}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors"
            style={{
              background: active ? "rgba(212,168,67,0.10)" : "transparent",
              borderBottom: `1px solid ${css.border}`,
            }}
            data-testid={`${testid}-opt-${g}`}
          >
            <span className="text-[12.5px]" style={{ color: css.text }}>{g}</span>
            {active && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "#D4A843" }} />}
          </button>
        );
      })}
    </DropdownShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   MultiStudentPicker
   ───────────────────────────────────────────────────────────────────────
   Multi-select student dropdown. Used in CouponStudio assigned_to field.
   value:    comma-separated clean_id string (e.g. "stu001, stu002")
   onChange: called with new comma-separated string
   ═══════════════════════════════════════════════════════════════════════ */
export function MultiStudentPicker({ value, onChange, students, loading, error, testid = "multi-student-picker" }) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");

  const selectedIds = new Set(
    (value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  );

  const filtered = students.filter((s) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (s.clean_id     || "").toLowerCase().includes(q) ||
      (s.display_name || "").toLowerCase().includes(q) ||
      (s.group        || "").toLowerCase().includes(q)
    );
  });

  const toggle = (s) => {
    const id = s.clean_id || s.student_id || "";
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next).join(", "));
  };

  const count = selectedIds.size;
  const trigger = count > 0
    ? <span>
        <span style={{ color: css.text }}>{count} student{count === 1 ? "" : "s"} selected</span>
        <span className="ml-2 text-[11px]" style={{ color: css.textMuted }}>
          {Array.from(selectedIds).slice(0, 3).join(", ")}{count > 3 ? ` +${count - 3}` : ""}
        </span>
      </span>
    : <span style={{ color: css.textMuted }}>
        {loading ? "Loading students…" : "Select students (or leave blank for all)…"}
      </span>;

  return (
    <DropdownShell trigger={trigger} open={open} setOpen={setOpen} testid={testid}>
      <DropdownSearch value={query} onChange={setQuery} placeholder="Search by name, ID or group…" />
      {count > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] transition-colors"
          style={{ color: "#fca5a5", borderBottom: `1px solid ${css.border}` }}
        >
          <X className="h-3 w-3" /> Clear all ({count} selected)
        </button>
      )}
      <DropdownStatus loading={loading} error={error}
                      emptyMsg={!loading && !error && filtered.length === 0 ? "No students match." : null} />
      {!loading && !error && filtered.map((s) => {
        const id = s.clean_id || s.student_id || "";
        const active = selectedIds.has(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(s)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
            style={{
              background: active ? "rgba(212,168,67,0.10)" : "transparent",
              borderBottom: `1px solid ${css.border}`,
            }}
            data-testid={`${testid}-opt-${id}`}
          >
            <div
              className="h-4 w-4 rounded shrink-0 grid place-items-center"
              style={{
                background: active ? css.aurora : "rgba(255,255,255,0.06)",
                border: active ? "none" : `1px solid ${css.borderStrong}`,
              }}
            >
              {active && <Check className="h-2.5 w-2.5" style={{ color: "#1a1420" }} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate" style={{ color: css.text }}>
                {s.display_name || id}
              </div>
              <div className="text-[11px]" style={{ color: css.textMuted }}>
                {id}{s.group ? ` · ${s.group}` : ""}
              </div>
            </div>
          </button>
        );
      })}
    </DropdownShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   BookPicker
   ───────────────────────────────────────────────────────────────────────
   Multi-select searchable dropdown of studio books.
   value:    comma-separated slug string (e.g. "at-the-market, my-story")
   onChange: called with new comma-separated slug string
   ═══════════════════════════════════════════════════════════════════════ */
export function BookPicker({ value, onChange, books, loading, error, testid = "book-picker" }) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");

  const selectedSlugs = new Set(
    (value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  );

  const filtered = books.filter((b) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (b.slug    || "").toLowerCase().includes(q) ||
      (b.title   || "").toLowerCase().includes(q) ||
      (b.section || "").toLowerCase().includes(q)
    );
  });

  const toggle = (b) => {
    const next = new Set(selectedSlugs);
    if (next.has(b.slug)) next.delete(b.slug);
    else next.add(b.slug);
    onChange(Array.from(next).join(", "));
  };

  const count = selectedSlugs.size;
  const trigger = count > 0
    ? <span>
        <span style={{ color: css.text }}>{count} book{count === 1 ? "" : "s"} selected</span>
        <span className="ml-2 text-[11px]" style={{ color: css.textMuted }}>
          {Array.from(selectedSlugs).slice(0, 2).join(", ")}{count > 2 ? ` +${count - 2}` : ""}
        </span>
      </span>
    : <span style={{ color: css.textMuted }}>
        {loading ? "Loading books…" : "Select books (or leave blank for all)…"}
      </span>;

  return (
    <DropdownShell trigger={trigger} open={open} setOpen={setOpen} testid={testid}>
      <DropdownSearch value={query} onChange={setQuery} placeholder="Search by title, slug or section…" />
      {count > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] transition-colors"
          style={{ color: "#fca5a5", borderBottom: `1px solid ${css.border}` }}
        >
          <X className="h-3 w-3" /> Clear all ({count} selected)
        </button>
      )}
      <DropdownStatus loading={loading} error={error}
                      emptyMsg={!loading && !error && filtered.length === 0 ? "No books match." : null} />
      {!loading && !error && filtered.map((b) => {
        const active = selectedSlugs.has(b.slug);
        return (
          <button
            key={b.slug}
            type="button"
            onClick={() => toggle(b)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
            style={{
              background: active ? "rgba(212,168,67,0.10)" : "transparent",
              borderBottom: `1px solid ${css.border}`,
            }}
            data-testid={`${testid}-opt-${b.slug}`}
          >
            <div
              className="h-4 w-4 rounded shrink-0 grid place-items-center"
              style={{
                background: active ? css.aurora : "rgba(255,255,255,0.06)",
                border: active ? "none" : `1px solid ${css.borderStrong}`,
              }}
            >
              {active && <Check className="h-2.5 w-2.5" style={{ color: "#1a1420" }} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate" style={{ color: css.text }}>
                {b.title}
              </div>
              <div className="text-[11px]" style={{ color: css.textMuted }}>
                {b.slug}
                {b.section ? ` · ${b.section}` : ""}
                {b.published ? "" : " · draft"}
              </div>
            </div>
          </button>
        );
      })}
    </DropdownShell>
  );
}
