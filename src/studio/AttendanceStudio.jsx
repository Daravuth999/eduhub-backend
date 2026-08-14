/**
 * AttendanceStudio.jsx — teacher-only Attendance Studio panel.
 * Panels: Classes · Sessions · Live Roster · Needs Encouragement · Settings · Reports
 * Professional admin UI — not game-styled. All admin-only data stays here.
 */
import { useState, useEffect, useCallback } from "react";
import {
  CalendarCheck, Users, Radio, AlertTriangle, Settings as SettingsIcon,
  BarChart2, Plus, Pencil, Trash2, Play, Square, Bell, RefreshCw,
  Download, ChevronDown, ChevronUp, X, Check, Copy,
} from "lucide-react";
import * as api from "./attendanceAdminApi";

// ── helpers ───────────────────────────────────────────────────────────────────
const fmt = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  return iso.slice(0, 10);
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

// datetime-local inputs give local time without timezone ("YYYY-MM-DDTHH:mm").
// The backend expects UTC ISO strings. These two helpers handle the round-trip.
const localDtToUtcIso = (v) => {
  if (!v) return undefined;
  const d = new Date(v);          // browser parses as LOCAL time
  return isNaN(d.getTime()) ? undefined : d.toISOString();   // → UTC
};
const utcIsoToLocalDt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);        // parsed as UTC
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  // Format as local time "YYYY-MM-DDTHH:mm" — what datetime-local expects
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const TIER_COLORS = {
  bronze: "#CD7F32", silver: "#A8A9AD", gold: "#D4A843", diamond: "#b9f2ff",
};

function Pill({ children, color = "#D4A843" }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
          style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    scheduled: { label: "Scheduled", color: "#6b9fff" },
    open:       { label: "Open",      color: "#4ade80" },
    closed:     { label: "Closed",    color: "#a1a1aa" },
    present_full:    { label: "On-time",  color: "#4ade80" },
    present_partial: { label: "Late",     color: "#f59e0b" },
    late:            { label: "Late",     color: "#f59e0b" },
    absent:          { label: "Absent",   color: "#f87171" },
  };
  const { label, color } = map[status] || { label: status || "—", color: "#a1a1aa" };
  return <Pill color={color}>{label}</Pill>;
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-white/10 p-5 ${className}`}
         style={{ background: "rgba(20,14,32,0.55)" }}>
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }) {
  return (
    <h2 className="flex items-center gap-2 text-[14px] font-bold text-parchment mb-4">
      <Icon className="h-4 w-4 text-gold" /> {children}
    </h2>
  );
}

function Btn({ children, onClick, variant = "default", size = "sm", disabled, className = "" }) {
  const base = "inline-flex items-center gap-1.5 rounded-full font-bold uppercase tracking-wider transition-all disabled:opacity-40";
  const sz = size === "sm" ? "px-3 py-1.5 text-[10.5px]" : "px-4 py-2 text-[12px]";
  const variants = {
    default: "border border-parchment/25 bg-walnut/50 text-parchment hover:border-gold hover:text-gold",
    gold: "text-ink border border-gold/60 hover:opacity-90",
    danger: "border border-red-400/40 bg-red-900/20 text-red-300 hover:border-red-300",
    green: "border border-emerald-400/40 bg-emerald-900/20 text-emerald-300 hover:border-emerald-300",
  };
  const style = variant === "gold"
    ? { background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }
    : {};
  return (
    <button onClick={onClick} disabled={disabled} style={style}
            className={`${base} ${sz} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, required, small }) {
  return (
    <div className={small ? "" : "flex flex-col gap-1"}>
      {label && <label className="text-[11px] text-white/60 font-medium">{label}{required && " *"}</label>}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
             placeholder={placeholder}
             className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-parchment placeholder-white/25 focus:border-gold/40 focus:outline-none" />
    </div>
  );
}

function Textarea({ label, value, onChange, placeholder, rows = 3 }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-[11px] text-white/60 font-medium">{label}</label>}
      <textarea value={value} onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder} rows={rows}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-parchment placeholder-white/25 focus:border-gold/40 focus:outline-none resize-y" />
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer select-none">
      <button type="button" onClick={() => onChange(!checked)}
              className="w-9 h-5 rounded-full border transition-all relative shrink-0"
              style={{
                background: checked ? "#D4A843" : "rgba(255,255,255,0.08)",
                borderColor: checked ? "#D4A843" : "rgba(255,255,255,0.15)",
              }}>
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
              style={{ left: checked ? "18px" : "2px" }} />
      </button>
      <span className="text-[12px] text-white/80">{label}</span>
    </label>
  );
}

function ErrMsg({ err }) {
  if (!err) return null;
  return (
    <p className="text-[11px] text-red-400 mt-1">
      {err?.message || String(err)}
    </p>
  );
}

// ── ROSTER PICKER ─────────────────────────────────────────────────────────────
// Searchable multi-select for student roster. selectedIds: string[]
// NOTE: backend /api/teacher/students returns snake_case → student_id, display_name
function RosterPicker({ selectedIds = [], onChange }) {
  const [students, setStudents] = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.listAllStudents()
      .then((d) => setStudents(d.students || []))
      .catch(() => setStudents([]))
      .finally(() => setLoadingStudents(false));
  }, []);

  const selected = new Set(selectedIds);

  const sid = (s) => s.student_id || s.studentId || s.id || "";

  const filtered = query.trim()
    ? students.filter((s) => {
        const q = query.toLowerCase();
        return (
          sid(s).toLowerCase().includes(q) ||
          (s.display_name || "").toLowerCase().includes(q) ||
          (s.group || "").toLowerCase().includes(q)
        );
      })
    : students;

  const toggle = (id) => {
    if (!id) return; // guard against undefined IDs
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const selectAll = () => onChange(filtered.map(sid).filter(Boolean));
  const clearAll  = () => onChange([]);

  const nameFor = (id) => {
    const s = students.find((x) => sid(x) === id);
    return s?.display_name || id;
  };

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-white/45">
        Roster — {selectedIds.length} student{selectedIds.length !== 1 ? "s" : ""} selected
      </p>

      {/* Selected chips */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-white/[0.03] border border-white/10 min-h-[40px]">
          {selectedIds.map((id) => (
            <span key={id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold/15 text-gold border border-gold/25">
              {nameFor(id)}
              <button type="button" onClick={() => toggle(id)} className="ml-0.5 text-gold/60 hover:text-gold">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Toggle dropdown */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[12px] text-white/70 border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors">
        <span>{loadingStudents ? "Loading students…" : `Search & select students (${students.length} total)`}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && !loadingStudents && (
        <div className="rounded-lg border border-white/10 bg-[rgba(12,8,24,0.92)] overflow-hidden">
          {/* Search row */}
          <div className="px-3 py-2 border-b border-white/5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or ID…"
              className="w-full bg-transparent text-[12px] text-white outline-none placeholder:text-white/30"
            />
          </div>
          {/* Bulk actions — separate row so mobile touches don't bleed into the search/list */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-b border-white/5 bg-white/[0.02]">
            <button type="button" onClick={selectAll}
                    className="text-[11px] font-medium text-gold/80 hover:text-gold py-1 px-2 rounded">
              Select all ({filtered.length})
            </button>
            <span className="text-white/15 text-[10px]">|</span>
            <button type="button" onClick={clearAll}
                    className="text-[11px] font-medium text-white/40 hover:text-white/70 py-1 px-2 rounded">
              Clear
            </button>
          </div>

          {/* Student list */}
          <div className="max-h-52 overflow-y-auto divide-y divide-white/[0.04]">
            {filtered.length === 0 && (
              <p className="text-[11px] text-white/30 px-3 py-3 text-center">No students match.</p>
            )}
            {filtered.map((s) => {
              const id = sid(s);
              const checked = selected.has(id);
              return (
                <div key={id || s.display_name}
                     onClick={() => toggle(id)}
                     className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors select-none ${checked ? "bg-gold/[0.08]" : "hover:bg-white/[0.03]"}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {}} // controlled — click handled by parent div
                    onClick={(e) => e.stopPropagation()}
                    className="accent-gold w-4 h-4 shrink-0 pointer-events-none"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12px] text-parchment font-medium truncate">
                      {s.display_name || id}
                    </span>
                    <span className="block text-[10px] text-white/40 font-mono truncate">
                      {id}{s.group ? ` · ${s.group}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── CLASSES PANEL ─────────────────────────────────────────────────────────────
const BLANK_CLASS = { title_en: "", title_kh: "", teacher: "", recurrence: "", group: "", roster: [] };

function ClassesPanel() {
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null); // null = closed, {} = new, {class_id,...} = edit
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.listClasses();
      setClasses(d.classes || []);
    } catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => setForm({ ...BLANK_CLASS });
  const openEdit = (c) => setForm({ ...c, roster: c.roster || [] });

  const handleSave = async () => {
    if (!form.title_en.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title_en: form.title_en.trim(),
        title_kh: form.title_kh?.trim() || "",
        teacher: form.teacher?.trim() || "",
        recurrence: form.recurrence?.trim() || "",
        group: form.group?.trim() || "",
        roster: Array.isArray(form.roster) ? form.roster : [],
      };
      if (form.class_id) await api.updateClass(form.class_id, payload);
      else await api.createClass(payload);
      setForm(null);
      load();
    } catch (e) { setErr(e); }
    finally { setSaving(false); }
  };

  const handleDelete = async (class_id) => {
    if (!window.confirm("Delete this class?")) return;
    try { await api.deleteClass(class_id); load(); }
    catch (e) { setErr(e); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle icon={Users}>Classes</SectionTitle>
        <div className="flex gap-2">
          <Btn onClick={load} disabled={loading}><RefreshCw className="h-3 w-3" /> Refresh</Btn>
          <Btn variant="gold" onClick={openNew}><Plus className="h-3 w-3" /> New Class</Btn>
        </div>
      </div>

      <ErrMsg err={err} />

      {form && (
        <Card className="border-gold/20">
          <h3 className="text-[13px] font-bold text-gold mb-3">
            {form.class_id ? "Edit Class" : "New Class"}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Input label="Title (English)" value={form.title_en} onChange={(v) => setForm({ ...form, title_en: v })} required />
            <Input label="Title (Khmer)" value={form.title_kh || ""} onChange={(v) => setForm({ ...form, title_kh: v })} />
            <Input label="Teacher name" value={form.teacher || ""} onChange={(v) => setForm({ ...form, teacher: v })} />
            <Input label="Recurrence (e.g. Mon/Wed 9am)" value={form.recurrence || ""} onChange={(v) => setForm({ ...form, recurrence: v })} />
            <Input label="Group tag (e.g. A1)" value={form.group || ""} onChange={(v) => setForm({ ...form, group: v })} />
          </div>
          <RosterPicker
            selectedIds={form.roster || []}
            onChange={(ids) => setForm({ ...form, roster: ids })}
          />
          <div className="flex gap-2 mt-3">
            <Btn variant="gold" onClick={handleSave} disabled={saving || !form.title_en?.trim()}>
              <Check className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
            </Btn>
            <Btn onClick={() => setForm(null)}><X className="h-3 w-3" /> Cancel</Btn>
          </div>
        </Card>
      )}

      {loading && <p className="text-[12px] text-white/40">Loading classes…</p>}
      {!loading && classes.length === 0 && (
        <p className="text-[12px] text-white/40">No classes yet. Create one to get started.</p>
      )}

      <div className="space-y-2">
        {classes.map((c) => (
          <Card key={c.class_id}>
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-parchment truncate">{c.title_en}</p>
                {c.title_kh && <p className="text-[11px] text-white/50">{c.title_kh}</p>}
                <div className="flex flex-wrap gap-2 mt-1">
                  {c.teacher && <span className="text-[10px] text-white/50">Teacher: {c.teacher}</span>}
                  {c.recurrence && <span className="text-[10px] text-white/50">· {c.recurrence}</span>}
                  {c.group && <Pill color="#6b9fff">{c.group}</Pill>}
                  <span className="text-[10px] text-white/40">{(c.roster || []).length} enrolled</span>
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <Btn onClick={() => openEdit(c)}><Pencil className="h-3 w-3" /></Btn>
                <Btn variant="danger" onClick={() => handleDelete(c.class_id)}><Trash2 className="h-3 w-3" /></Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── SESSIONS PANEL ────────────────────────────────────────────────────────────
const BLANK_SESSION = {
  class_id: "", date: "", opens_at: "", closes_at: "", meet_url: "",
  grace_minutes: "", mid_session_enabled: true,
};

function SessionsPanel() {
  const [classes, setClasses] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [filterClass, setFilterClass] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);

  const loadClasses = useCallback(async () => {
    try { const d = await api.listClasses(); setClasses(d.classes || []); } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.listSessions(filterClass || undefined);
      setSessions(d.sessions || []);
    } catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [filterClass]);

  useEffect(() => { loadClasses(); }, [loadClasses]);
  useEffect(() => { load(); }, [load]);

  const toast = (msg) => { setActionMsg(msg); setTimeout(() => setActionMsg(null), 3500); };

  const handleAction = async (fn, ...args) => {
    try { const r = await fn(...args); load(); return r; }
    catch (e) { setErr(e); }
  };

  const handleOpen = async (session_id) => {
    const r = await handleAction(api.openSession, session_id);
    if (r?.ok) toast(`Session opened. Push sent: ${r.live_now_push_sent ?? 0}`);
  };

  const handleClose = async (session_id) => {
    if (!window.confirm("Close session and finalize all attendance records?")) return;
    const r = await handleAction(api.closeSession, session_id);
    if (r?.ok)
      toast(`Closed. Present: ${r.present_count}, Absent: ${r.absent_count}, Rewards: ${r.rewards_credited}`);
  };

  const handleNudge = async (session_id) => {
    const r = await handleAction(api.closingSoonNudge, session_id);
    if (r?.ok) toast(`Closing-soon nudge sent to ${r.sent} students (${r.pending_count} pending)`);
  };

  const handleSave = async () => {
    if (!form.class_id) return;
    setSaving(true);
    try {
      const payload = {
        class_id: form.class_id,
        date: form.date || undefined,
        opens_at: localDtToUtcIso(form.opens_at),    // local → UTC
        closes_at: localDtToUtcIso(form.closes_at),  // local → UTC
        meet_url: form.meet_url || "",
        grace_minutes: form.grace_minutes !== "" ? Number(form.grace_minutes) : undefined,
        mid_session_enabled: form.mid_session_enabled,
      };
      if (form.session_id) await api.updateSession(form.session_id, payload);
      else await api.createSession(payload);
      setForm(null);
      load();
    } catch (e) { setErr(e); }
    finally { setSaving(false); }
  };

  const copyJoinLink = (slug) => {
    const base = window.location.origin;
    navigator.clipboard?.writeText(`${base}/attendance/j/${slug}`);
    toast("Join link copied!");
  };

  const className = (class_id) =>
    classes.find((c) => c.class_id === class_id)?.title_en || class_id;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionTitle icon={CalendarCheck}>Sessions</SectionTitle>
        <div className="flex gap-2 flex-wrap">
          <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-parchment focus:outline-none">
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.title_en}</option>)}
          </select>
          <Btn onClick={load} disabled={loading}><RefreshCw className="h-3 w-3" /> Refresh</Btn>
          <Btn variant="gold" onClick={() => setForm({ ...BLANK_SESSION })}><Plus className="h-3 w-3" /> New Session</Btn>
        </div>
      </div>

      {actionMsg && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-4 py-2.5 text-[12px] text-emerald-300">
          {actionMsg}
        </div>
      )}
      <ErrMsg err={err} />

      {form && (
        <Card className="border-gold/20">
          <h3 className="text-[13px] font-bold text-gold mb-3">
            {form.session_id ? "Edit Session" : "New Session"}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-white/60 font-medium">Class *</label>
              <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-parchment focus:outline-none">
                <option value="">Select a class…</option>
                {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.title_en}</option>)}
              </select>
            </div>
            <Input label="Date (YYYY-MM-DD)" type="date" value={form.date || ""} onChange={(v) => setForm({ ...form, date: v })} />
            <Input label="Opens at (your local time)" type="datetime-local" value={form.opens_at || ""} onChange={(v) => setForm({ ...form, opens_at: v })} />
            <Input label="Closes at (your local time)" type="datetime-local" value={form.closes_at || ""} onChange={(v) => setForm({ ...form, closes_at: v })} />
            <Input label="Google Meet URL" value={form.meet_url || ""} onChange={(v) => setForm({ ...form, meet_url: v })} placeholder="https://meet.google.com/..." />
            <Input label="Grace window (minutes)" type="number" value={form.grace_minutes} onChange={(v) => setForm({ ...form, grace_minutes: v })} placeholder="10" />
          </div>
          <Toggle label="Mid-session confirmation required" checked={form.mid_session_enabled}
                  onChange={(v) => setForm({ ...form, mid_session_enabled: v })} />
          <div className="flex gap-2 mt-3">
            <Btn variant="gold" onClick={handleSave} disabled={saving || !form.class_id}>
              <Check className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
            </Btn>
            <Btn onClick={() => setForm(null)}><X className="h-3 w-3" /> Cancel</Btn>
          </div>
        </Card>
      )}

      {loading && <p className="text-[12px] text-white/40">Loading sessions…</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-[12px] text-white/40">No sessions found.</p>
      )}

      <div className="space-y-2">
        {sessions.map((s) => (
          <Card key={s.session_id}>
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[13px] font-semibold text-parchment">{className(s.class_id)}</p>
                  <StatusBadge status={s.status} />
                  {s.date && <span className="text-[10px] text-white/40">{s.date}</span>}
                </div>
                <div className="flex flex-wrap gap-3 mt-1 text-[10px] text-white/45">
                  <span>Opens: {fmt(s.opens_at)}</span>
                  <span>Closes: {fmt(s.closes_at)}</span>
                  {s.grace_minutes && <span>Grace: {s.grace_minutes}m</span>}
                </div>
                {s.join_slug && (
                  <button onClick={() => copyJoinLink(s.join_slug)}
                          className="mt-1 flex items-center gap-1 text-[10px] text-gold/70 hover:text-gold transition-colors">
                    <Copy className="h-2.5 w-2.5" /> Copy join link (/attendance/j/{s.join_slug})
                  </button>
                )}
              </div>
              <div className="flex gap-1.5 flex-wrap shrink-0">
                {s.status === "scheduled" && (
                  <Btn variant="green" onClick={() => handleOpen(s.session_id)}>
                    <Play className="h-3 w-3" /> Open
                  </Btn>
                )}
                {s.status === "open" && (
                  <>
                    <Btn onClick={() => handleNudge(s.session_id)}>
                      <Bell className="h-3 w-3" /> Nudge
                    </Btn>
                    <Btn variant="danger" onClick={() => handleClose(s.session_id)}>
                      <Square className="h-3 w-3" /> Close
                    </Btn>
                  </>
                )}
                <Btn onClick={() => setForm({
                  ...s,
                  opens_at: utcIsoToLocalDt(s.opens_at),   // UTC → local for input
                  closes_at: utcIsoToLocalDt(s.closes_at), // UTC → local for input
                  roster: undefined,
                })}>
                  <Pencil className="h-3 w-3" />
                </Btn>
                <Btn variant="danger" onClick={() => handleAction(api.deleteSession, s.session_id)}>
                  <Trash2 className="h-3 w-3" />
                </Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── LIVE ROSTER PANEL ─────────────────────────────────────────────────────────
function LiveRosterPanel() {
  const [classes, setClasses] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadClasses = useCallback(async () => {
    try { const d = await api.listClasses(); setClasses(d.classes || []); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadClasses(); }, [loadClasses]);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [sessData, reportData] = await Promise.all([
        api.listSessions(selectedClass || undefined),
        api.getReport(currentMonth(), selectedClass || undefined),
      ]);
      setSessions((sessData.sessions || []).filter((s) => s.status === "open"));
      setReport(reportData);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [selectedClass]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const studentMap = {};
  (report?.per_student || []).forEach((s) => { studentMap[s.student_id] = s; });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionTitle icon={Radio}>Live Roster</SectionTitle>
        <div className="flex gap-2 flex-wrap items-center">
          <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-parchment focus:outline-none">
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.title_en}</option>)}
          </select>
          <Btn onClick={loadRoster} disabled={loading}><RefreshCw className="h-3 w-3" /> Refresh</Btn>
          {lastUpdated && <span className="text-[10px] text-white/30">Updated {lastUpdated}</span>}
        </div>
      </div>

      <ErrMsg err={err} />

      {sessions.length === 0 && !loading && (
        <Card>
          <p className="text-[12px] text-white/50 text-center py-4">No sessions currently open.</p>
        </Card>
      )}

      {sessions.map((s) => {
        const cls = classes.find((c) => c.class_id === s.class_id);
        return (
          <Card key={s.session_id} className="border-emerald-400/20">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <p className="text-[13px] font-bold text-emerald-300">LIVE — {cls?.title_en || s.class_id}</p>
              <span className="text-[10px] text-white/40 ml-auto">Closes: {fmt(s.closes_at)}</span>
            </div>
            <p className="text-[11px] text-white/45 mb-3">
              Join: <span className="text-gold font-mono text-[10px]">{window.location.origin}/attendance/j/{s.join_slug}</span>
            </p>
            {loading && <p className="text-[11px] text-white/40">Loading roster…</p>}
            {!loading && report && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-white/40 border-b border-white/10">
                      <th className="text-left pb-1.5 font-medium">Student ID</th>
                      <th className="text-center pb-1.5 font-medium">Present</th>
                      <th className="text-center pb-1.5 font-medium">Late</th>
                      <th className="text-center pb-1.5 font-medium">Absent</th>
                      <th className="text-center pb-1.5 font-medium">Attendance %</th>
                      <th className="text-center pb-1.5 font-medium">Tier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {report.per_student.map((st) => (
                      <tr key={st.student_id} className="text-white/70">
                        <td className="py-1.5 font-mono text-parchment">{st.student_id}</td>
                        <td className="text-center text-emerald-400">{st.present_full}</td>
                        <td className="text-center text-amber-400">{(st.late || 0) + (st.present_partial || 0)}</td>
                        <td className="text-center text-red-400">{st.absent}</td>
                        <td className="text-center">{st.attendance_pct ?? "—"}%</td>
                        <td className="text-center">
                          <span style={{ color: TIER_COLORS[st.reliability_tier] || "#a1a1aa" }}
                                className="font-bold capitalize">{st.reliability_tier || "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.per_student.length === 0 && (
                  <p className="text-[11px] text-white/40 mt-2 text-center">No attendance records for this month yet.</p>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {!loading && report && sessions.length > 0 && (
        <Card>
          <p className="text-[11px] text-white/40 mb-1">Session totals this month</p>
          <div className="flex gap-4 text-[12px]">
            <span className="text-emerald-300">✓ {report.per_class?.present_full || 0} on-time</span>
            <span className="text-amber-300">⏱ {(report.per_class?.late || 0) + (report.per_class?.present_partial || 0)} late</span>
            <span className="text-red-300">✗ {report.per_class?.absent || 0} absent</span>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── NEEDS ENCOURAGEMENT PANEL ─────────────────────────────────────────────────
function NeedsEncouragementPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [nudging, setNudging] = useState(false);
  const [nudgeMsg, setNudgeMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try { setData(await api.getAtRisk()); }
    catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleNudge = async () => {
    setNudging(true);
    try {
      const r = await api.fireAtRiskNudge();
      setNudgeMsg(`Nudge sent to ${r.sent} student(s). Candidates: ${r.candidates}`);
    } catch (e) { setErr(e); }
    finally { setNudging(false); }
  };

  const students = data?.students || [];
  const threshold = data?.threshold ?? 70;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionTitle icon={AlertTriangle}>Needs Encouragement</SectionTitle>
        <div className="flex gap-2">
          <Btn onClick={load} disabled={loading}><RefreshCw className="h-3 w-3" /> Refresh</Btn>
          <Btn variant="gold" onClick={handleNudge} disabled={nudging || students.length === 0}>
            <Bell className="h-3 w-3" /> {nudging ? "Sending…" : "Send Nudge to All"}
          </Btn>
        </div>
      </div>

      <div className="rounded-xl border border-amber-400/20 bg-amber-900/10 px-4 py-3 text-[12px] text-amber-300/80">
        Private teacher view — these students have a risk score ≥ {threshold}. This list is never
        shown to students. Use nudges to offer support proactively.
      </div>

      <ErrMsg err={err} />
      {nudgeMsg && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-4 py-2.5 text-[12px] text-emerald-300">
          {nudgeMsg}
        </div>
      )}

      {loading && <p className="text-[12px] text-white/40">Loading…</p>}
      {!loading && students.length === 0 && (
        <Card>
          <p className="text-[13px] text-emerald-300 text-center py-4">
            No students currently need encouragement. Keep it up!
          </p>
        </Card>
      )}

      <div className="space-y-2">
        {students.map((s) => (
          <Card key={s.student_id}>
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-parchment font-mono">{s.student_id}</p>
                <div className="flex flex-wrap gap-2 mt-1">
                  <span className="text-[10px] text-white/45">
                    Attendance: {s.attendance_rate != null ? `${Math.round(s.attendance_rate * 100)}%` : "—"}
                  </span>
                  <span className="text-[10px] text-white/45">
                    On-time: {s.on_time_rate_rolling != null ? `${Math.round(s.on_time_rate_rolling * 100)}%` : "—"}
                  </span>
                  <span className="text-[10px] text-white/45">Streak: {s.current_streak ?? 0}</span>
                  <Pill color={TIER_COLORS[s.reliability_tier] || "#a1a1aa"}>{s.reliability_tier || "bronze"}</Pill>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[13px] font-bold" style={{ color: s.risk_score >= 85 ? "#f87171" : "#f59e0b" }}>
                  {s.risk_score ?? "—"}
                </p>
                <p className="text-[9px] text-white/30">risk score</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── SETTINGS PANEL ────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  checkin_window_minutes: 90,
  late_grace_minutes: 10,
  mid_session_enabled: true,
  miss_threshold: 3,
  escalation_threshold: 70,
  base_attendance_points: 5,
  notifications: {
    live_now_enabled: true,
    closing_soon_enabled: true,
    mid_session_push_enabled: true,
    predictive_at_risk_enabled: false,
  },
};

function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.getSettings(); setSettings(d.settings || DEFAULT_SETTINGS); }
    catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));
  const setNotif = (key, value) =>
    setSettings((prev) => ({ ...prev, notifications: { ...(prev.notifications || {}), [key]: value } }));

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setErr(e); }
    finally { setSaving(false); }
  };

  if (loading) return <p className="text-[12px] text-white/40">Loading settings…</p>;
  if (!settings) return <ErrMsg err={err} />;

  const notif = settings.notifications || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle icon={SettingsIcon}>Settings</SectionTitle>
        <Btn variant="gold" onClick={handleSave} disabled={saving}>
          <Check className="h-3 w-3" /> {saving ? "Saving…" : saved ? "Saved!" : "Save Settings"}
        </Btn>
      </div>

      <ErrMsg err={err} />

      <Card>
        <p className="text-[11px] font-bold text-white/50 uppercase tracking-widest mb-3">Check-in Window</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Check-in window (minutes)" type="number" value={settings.checkin_window_minutes ?? 90}
                 onChange={(v) => set("checkin_window_minutes", Number(v))} />
          <Input label="Late grace period (minutes)" type="number" value={settings.late_grace_minutes ?? 10}
                 onChange={(v) => set("late_grace_minutes", Number(v))} />
          <Input label="Miss threshold (sessions)" type="number" value={settings.miss_threshold ?? 3}
                 onChange={(v) => set("miss_threshold", Number(v))} />
        </div>
        <div className="mt-3">
          <Toggle label="Mid-session confirmation required by default"
                  checked={!!settings.mid_session_enabled}
                  onChange={(v) => set("mid_session_enabled", v)} />
        </div>
      </Card>

      <Card>
        <p className="text-[11px] font-bold text-white/50 uppercase tracking-widest mb-3">Rewards</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Base attendance points per session" type="number"
                 value={settings.base_attendance_points ?? 5}
                 onChange={(v) => set("base_attendance_points", Number(v))} />
          <Input label="At-risk escalation threshold (risk score)" type="number"
                 value={settings.escalation_threshold ?? 70}
                 onChange={(v) => set("escalation_threshold", Number(v))} />
        </div>
        <div className="mt-3 overflow-x-auto">
          <p className="text-[11px] text-white/40 mb-1">Tier multipliers (read-only — edit in code)</p>
          <table className="text-[11px] w-full">
            <thead>
              <tr className="text-white/30 border-b border-white/10">
                <th className="text-left pb-1 font-medium">Tier</th>
                <th className="text-center pb-1 font-medium">Min Attendance</th>
                <th className="text-center pb-1 font-medium">Min On-time</th>
                <th className="text-center pb-1 font-medium">Multiplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(settings.reward_tiers || []).map((t) => (
                <tr key={t.tier} className="text-white/60">
                  <td className="py-1 capitalize font-bold" style={{ color: TIER_COLORS[t.tier] }}>{t.tier}</td>
                  <td className="text-center">{Math.round(t.min_attendance_rate * 100)}%</td>
                  <td className="text-center">{Math.round(t.min_on_time_rate * 100)}%</td>
                  <td className="text-center">{t.multiplier}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <p className="text-[11px] font-bold text-white/50 uppercase tracking-widest mb-3">Notifications</p>
        <div className="flex flex-col gap-3">
          <Toggle label="Send 'Live Now' push when session opens"
                  checked={!!notif.live_now_enabled} onChange={(v) => setNotif("live_now_enabled", v)} />
          <Toggle label="Enable 'Closing Soon' nudge for pending check-ins"
                  checked={!!notif.closing_soon_enabled} onChange={(v) => setNotif("closing_soon_enabled", v)} />
          <Toggle label="Mid-session confirmation push"
                  checked={!!notif.mid_session_push_enabled} onChange={(v) => setNotif("mid_session_push_enabled", v)} />
          <Toggle label="Predictive at-risk nudges (auto-fires daily)"
                  checked={!!notif.predictive_at_risk_enabled} onChange={(v) => setNotif("predictive_at_risk_enabled", v)} />
        </div>
      </Card>
    </div>
  );
}

// ── REPORTS PANEL ─────────────────────────────────────────────────────────────
function ReportsPanel() {
  const [classes, setClasses] = useState([]);
  const [month, setMonth] = useState(currentMonth());
  const [classId, setClassId] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.listClasses().then((d) => setClasses(d.classes || [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try { setReport(await api.getReport(month, classId || undefined)); }
    catch (e) { setErr(e); }
    finally { setLoading(false); }
  }, [month, classId]);

  useEffect(() => { load(); }, [load]);

  const exportCSV = () => {
    if (!report?.per_student?.length) return;
    const rows = [
      ["Student ID", "Present", "Late", "Absent", "Attendance%", "On-time%", "Streak", "Tier"],
      ...report.per_student.map((s) => [
        s.student_id, s.present_full, (s.late || 0) + (s.present_partial || 0), s.absent,
        s.attendance_pct, s.on_time_pct, s.current_streak, s.reliability_tier,
      ]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-${month}${classId ? `-${classId}` : ""}.csv`;
    a.click();
  };

  const [expandedDate, setExpandedDate] = useState(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionTitle icon={BarChart2}>Reports</SectionTitle>
        <div className="flex gap-2 flex-wrap">
          <Btn onClick={exportCSV} disabled={!report?.per_student?.length}>
            <Download className="h-3 w-3" /> Export CSV
          </Btn>
          <Btn onClick={load} disabled={loading}><RefreshCw className="h-3 w-3" /> Refresh</Btn>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-white/50">Month</label>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
                 className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-parchment focus:outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-white/50">Class</label>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-parchment focus:outline-none">
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.title_en}</option>)}
          </select>
        </div>
      </div>

      <ErrMsg err={err} />
      {loading && <p className="text-[12px] text-white/40">Loading report…</p>}

      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Sessions", value: report.sessions, color: "#6b9fff" },
              { label: "On-time", value: report.per_class?.present_full || 0, color: "#4ade80" },
              { label: "Late", value: (report.per_class?.late || 0) + (report.per_class?.present_partial || 0), color: "#f59e0b" },
              { label: "Absent", value: report.per_class?.absent || 0, color: "#f87171" },
            ].map(({ label, value, color }) => (
              <Card key={label}>
                <p className="text-[11px] text-white/40">{label}</p>
                <p className="text-[22px] font-bold mt-0.5" style={{ color }}>{value}</p>
              </Card>
            ))}
          </div>

          {report.by_date?.length > 0 && (
            <Card>
              <button onClick={() => setExpandedDate(expandedDate ? null : "all")}
                      className="flex items-center gap-2 w-full text-left text-[12px] font-bold text-parchment">
                By Date {expandedDate ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {expandedDate && (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-white/30 border-b border-white/10">
                        <th className="text-left pb-1 font-medium">Date</th>
                        <th className="text-center pb-1 font-medium">Present</th>
                        <th className="text-center pb-1 font-medium">Partial</th>
                        <th className="text-center pb-1 font-medium">Late</th>
                        <th className="text-center pb-1 font-medium">Absent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {report.by_date.map((d) => (
                        <tr key={d.date} className="text-white/65">
                          <td className="py-1">{d.date}</td>
                          <td className="text-center text-emerald-400">{d.present}</td>
                          <td className="text-center text-amber-400">{d.partial}</td>
                          <td className="text-center text-amber-300">{d.late}</td>
                          <td className="text-center text-red-400">{d.absent}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          <Card>
            <p className="text-[12px] font-bold text-parchment mb-3">Per-student Breakdown</p>
            {report.per_student.length === 0 && (
              <p className="text-[11px] text-white/40">No records for this filter.</p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-white/30 border-b border-white/10">
                    <th className="text-left pb-1.5 font-medium">Student ID</th>
                    <th className="text-center pb-1.5 font-medium">On-time</th>
                    <th className="text-center pb-1.5 font-medium">Late</th>
                    <th className="text-center pb-1.5 font-medium">Absent</th>
                    <th className="text-center pb-1.5 font-medium">Att%</th>
                    <th className="text-center pb-1.5 font-medium">On-time%</th>
                    <th className="text-center pb-1.5 font-medium">Streak</th>
                    <th className="text-center pb-1.5 font-medium">Tier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {report.per_student.map((s) => (
                    <tr key={s.student_id} className="text-white/65">
                      <td className="py-1.5 font-mono text-parchment">{s.student_id}</td>
                      <td className="text-center text-emerald-400">{s.present_full}</td>
                      <td className="text-center text-amber-400">{(s.late || 0) + (s.present_partial || 0)}</td>
                      <td className="text-center text-red-400">{s.absent}</td>
                      <td className="text-center">{s.attendance_pct}%</td>
                      <td className="text-center">{s.on_time_pct}%</td>
                      <td className="text-center">{s.current_streak}</td>
                      <td className="text-center capitalize font-bold"
                          style={{ color: TIER_COLORS[s.reliability_tier] || "#a1a1aa" }}>
                        {s.reliability_tier || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ── MAIN SHELL ─────────────────────────────────────────────────────────────────
const PANELS = [
  { key: "classes",       label: "Classes",             Icon: Users },
  { key: "sessions",      label: "Sessions",            Icon: CalendarCheck },
  { key: "roster",        label: "Live Roster",         Icon: Radio },
  { key: "encouragement", label: "Needs Encouragement", Icon: AlertTriangle },
  { key: "settings",      label: "Settings",            Icon: SettingsIcon },
  { key: "reports",       label: "Reports",             Icon: BarChart2 },
];

export default function AttendanceStudio() {
  const [panel, setPanel] = useState("classes");

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 border-b border-white/8 pb-4 flex-wrap">
        <CalendarCheck className="h-5 w-5 text-gold" />
        <h1 className="font-display text-[16px] text-parchment">Attendance Studio</h1>
        <span className="text-[11px] text-white/30">Constellation Check-In</span>
      </div>

      <nav className="flex flex-wrap gap-1.5">
        {PANELS.map(({ key, label, Icon }) => {
          const active = panel === key;
          return (
            <button key={key} onClick={() => setPanel(key)}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wider transition-all"
                    style={{
                      background: active
                        ? "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)"
                        : "rgba(45,31,62,0.65)",
                      color: active ? "#1a1420" : "#F4E5C1",
                      border: active ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
                      boxShadow: active ? "0 4px 12px rgba(212,168,67,0.3)" : "none",
                    }}>
              <Icon className="h-3 w-3" /> {label}
            </button>
          );
        })}
      </nav>

      <div>
        {panel === "classes"       && <ClassesPanel />}
        {panel === "sessions"      && <SessionsPanel />}
        {panel === "roster"        && <LiveRosterPanel />}
        {panel === "encouragement" && <NeedsEncouragementPanel />}
        {panel === "settings"      && <SettingsPanel />}
        {panel === "reports"       && <ReportsPanel />}
      </div>
    </div>
  );
}
