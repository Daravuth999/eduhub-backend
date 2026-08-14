/**
 * PushStudio.jsx — Push Studio page (Compose · Scheduled · History).
 *
 * Self-contained: only imports React, lucide-react, and uses
 * REACT_APP_BACKEND_URL via studio/api.js. Mirrors the dark Studio look
 * (purple radial bg, gold/aurora accents, Plus Jakarta Sans).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, Send, Calendar, Trash2, Users, Hash, Globe, ChevronLeft,
  ChevronRight, History as HistoryIcon, Loader2, CheckCircle2, X, Play,
  Zap, TrendingUp, Sparkles, Wand2,
} from "lucide-react";
import { useStudioAuth } from "./StudioAuth";
import { getToken } from "./api";
// v10.1 — shared pickers
import { StudentPicker, GroupPicker, useStudentList } from "./components/StudioPickers";
// v11.0 — local template-based smart push message generator (no AI, no API).
import { PUSH_PRESETS, generateSamples, LANG_LABELS } from "./pushSampleTemplates";

/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL || "";
/* eslint-enable no-undef */

const css = {
  bg: "#0a0a0f",
  card: "rgba(255,255,255,0.04)",
  cardHover: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  text: "#F4E5C1",
  textMuted: "rgba(244,229,193,0.55)",
  aurora: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
  danger: "rgba(239, 68, 68, 0.9)",
};

async function pushApi(path, { method = "GET", body, qs } = {}) {
  let url = `${BASE}${path}`;
  if (qs) {
    const sp = new URLSearchParams(qs).toString();
    if (sp) url += `?${sp}`;
  }
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error((data && data.detail) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/* ========================================================================== */
/* Root                                                                        */
/* ========================================================================== */
export default function PushStudio() {
  const { user } = useStudioAuth();
  const isSuperAdmin = !!(user && user.is_admin);
  const [tab, setTab] = useState("compose");

  const tabs = [
    { key: "compose", label: "Compose", Icon: Send },
    { key: "scheduled", label: "Scheduled", Icon: Calendar },
    { key: "history", label: "History", Icon: HistoryIcon },
    { key: "quick", label: "Quick Push", Icon: Zap },
  ];

  return (
    <div data-testid="push-studio" className="rounded-3xl overflow-hidden push-studio-root"
         style={{ background: css.bg, border: `1px solid ${css.border}`,
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      {/* v11.1 (Task F) — scoped mobile overflow fix for iPhone portrait.
          Keeps the Push Studio fully inside the viewport: textareas/inputs
          wrap to 100%, the tab row scrolls horizontally inside its own row
          instead of pushing the parent, long Khmer/English copy wraps via
          word-break:break-word. Scoped to .push-studio-root so no global
          page styles and no other Studio panels are affected. */}
      <style>{`
        .push-studio-root, .push-studio-root * { box-sizing: border-box; }
        .push-studio-root { max-width: 100%; overflow-x: hidden; }
        .push-studio-root textarea,
        .push-studio-root input[type="text"],
        .push-studio-root input[type="url"],
        .push-studio-root input[type="search"],
        .push-studio-root input[type="number"],
        .push-studio-root input[type="email"],
        .push-studio-root input:not([type]) {
          width: 100%;
          max-width: 100%;
          min-width: 0;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .push-studio-root textarea { resize: vertical; }
        .push-studio-root .min-w-0,
        .push-studio-root [data-flex-min] { min-width: 0; }
        @media (max-width: 480px) {
          .push-studio-root > div:first-child { padding-left: 14px; padding-right: 14px; }
          .push-studio-root > div:nth-child(2) { padding-left: 14px; padding-right: 14px; }
          .push-studio-root > div:last-child { padding-left: 14px; padding-right: 14px; }
          .push-studio-root nav[data-testid="push-tabs"] { flex-wrap: nowrap !important; overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .push-studio-root nav[data-testid="push-tabs"] > button { flex-shrink: 0; }
          .push-studio-root [data-chip-row] { display: flex; flex-wrap: wrap; gap: 0.5rem; }
          .push-studio-root [data-action-row] { flex-wrap: wrap; }
          .push-studio-root .grid { grid-template-columns: 1fr !important; }
          .push-studio-root pre, .push-studio-root code {
            white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
          }
        }
        /* Khmer / long English in any element marked as long-text. */
        .push-studio-root [data-long-text],
        .push-studio-root .long-text {
          word-break: break-word;
          overflow-wrap: anywhere;
        }
      `}</style>
      <div className="px-6 py-5 flex items-center gap-3"
           style={{ borderBottom: `1px solid ${css.border}` }}>
        <div className="grid place-items-center h-9 w-9 rounded-xl"
             style={{ background: "rgba(212,168,67,0.12)", border: "1px solid rgba(212,168,67,0.35)" }}>
          <Bell className="h-4 w-4" style={{ color: "#D4A843" }} />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold" style={{ color: css.text }}>Push Studio</h2>
          <p className="text-[11px]" style={{ color: css.textMuted }}>
            Send, schedule, and audit web push notifications to your students.
          </p>
        </div>
        <div className="flex-1" />
        <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] px-2.5 py-1 rounded-full"
              style={{ color: isSuperAdmin ? "#1a1420" : css.text,
                       background: isSuperAdmin ? css.aurora : "rgba(255,255,255,0.06)",
                       border: `1px solid ${css.border}` }}
              data-testid="push-role-badge">
          {isSuperAdmin ? "Super-admin" : "Teacher"}
        </span>
      </div>

      <nav className="px-6 pt-4 pb-1 flex gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-visible"
           style={{ scrollbarWidth: "thin" }}
           data-testid="push-tabs">
        {tabs.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <button key={key} onClick={() => setTab(key)}
                    data-testid={`push-tab-${key}`}
                    className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider transition-all shrink-0"
                    style={{
                      background: active ? css.aurora : "rgba(255,255,255,0.04)",
                      color: active ? "#1a1420" : css.text,
                      border: active ? "1px solid rgba(255,225,154,0.6)" : `1px solid ${css.border}`,
                      minHeight: 36,
                    }}>
              <Icon className="h-3 w-3" /> {label}
            </button>
          );
        })}
      </nav>

      <div className="px-6 py-5">
        {tab === "compose"   && <Compose user={user} isSuperAdmin={isSuperAdmin} />}
        {tab === "scheduled" && <Scheduled isSuperAdmin={isSuperAdmin} />}
        {tab === "history"   && <HistoryView isSuperAdmin={isSuperAdmin} userEmail={user?.email} />}
        {tab === "quick"     && <QuickPush isSuperAdmin={isSuperAdmin} />}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Compose tab                                                                 */
/* ========================================================================== */
function Compose({ user, isSuperAdmin }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("everyone");
  const [studentIdsRaw, setStudentIdsRaw] = useState("");
  const [group, setGroup] = useState("");
  const [count, setCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [scheduleResult, setScheduleResult] = useState(null);
  const [error, setError] = useState(null);
  // v10.1 — load students for group + student pickers
  const { students, groups, loading: stuLoading, error: stuError } = useStudentList();

  const studentIds = useMemo(
    () => {
      // Surgical fix (Push Studio "By Student ID = 0 subscribers" bug):
      // de-duplicate the typed IDs (case-insensitive) AFTER trimming, so
      // the count poll and the actual send-studio call see the same
      // canonical set the backend will match against push_subscriptions.
      const raw = studentIdsRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const seen = new Set();
      const out = [];
      for (const id of raw) {
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
      }
      return out;
    },
    [studentIdsRaw]
  );

  /* ---- audience count (debounced 800ms) ------------------------------ */
  const debounceRef = useRef(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCountLoading(true);
      try {
        const qs = { target };
        if (target === "students") qs.studentIds = studentIds.join(",");
        if (target === "group")    qs.group = group;
        const r = await pushApi("/api/push/subscribers/count", { qs });
        setCount(r.count ?? 0);
      } catch {
        setCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 800);
    return () => clearTimeout(debounceRef.current);
  }, [target, studentIdsRaw, group, studentIds]);

  /* ---- send now ------------------------------------------------------- */
  const onSend = async () => {
    setError(null); setResult(null); setSending(true);
    try {
      const payload = {
        title, body, url: url || "/",
        target,
        studentIds: target === "students" ? studentIds : [],
        group: target === "group" ? group : "",
        sentBy: user?.email || "",
      };
      const r = await pushApi("/api/push/send-studio", { method: "POST", body: payload });
      setResult(r);
    } catch (e) {
      setError(e.message || "Send failed");
    } finally {
      setSending(false);
    }
  };

  /* ---- schedule ------------------------------------------------------- */
  const onSchedule = async () => {
    setError(null); setScheduleResult(null);
    try {
      // datetime-local → ISO with the user's local TZ offset preserved.
      const iso = new Date(sendAt).toISOString();
      const payload = {
        title, body, url: url || "/",
        target,
        studentIds: target === "students" ? studentIds : [],
        group: target === "group" ? group : "",
        sendAt: iso,
        createdBy: user?.email || "",
      };
      const r = await pushApi("/api/push/schedule", { method: "POST", body: payload });
      setScheduleResult(r);
      setScheduleOpen(false);
    } catch (e) {
      setError(e.message || "Schedule failed");
    }
  };

  const canSend = title.trim().length > 0 && body.trim().length > 0 && !sending;
  const canSchedule = canSend && sendAt && new Date(sendAt) > new Date();

  return (
    <div className="grid gap-5 md:grid-cols-[1fr_minmax(280px,360px)]" data-testid="push-compose">
      {/* ---- form ------------------------------------------------------ */}
      <div className="grid gap-4">
        {/* v11.0 — Smart sample generator (LOCAL templates, no AI/API).
            Teacher picks an announcement type → sample cards appear →
            "Use this sample" fills the Title + Message + Destination
            fields below. Teacher still edits and clicks Send manually. */}
        <SmartSampleGenerator
          onApplySample={(s) => {
            setTitle(s.title);
            setBody(s.body);
            if (s.suggestedUrl && !url) setUrl(s.suggestedUrl);
          }}
        />

        <Field label={`Title  ·  ${title.length}/50`}>
          <input value={title} maxLength={50}
                 onChange={(e) => setTitle(e.target.value)}
                 placeholder="New chapter unlocked"
                 data-testid="push-title-input"
                 className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                 style={inputStyle} />
        </Field>

        <Field label={`Message  ·  ${body.length}/120`}>
          <textarea value={body} maxLength={120} rows={3}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Tap to read tonight's bedtime story…"
                    data-testid="push-body-input"
                    className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                    style={inputStyle} />
        </Field>

        {/* v10.1 — destination picker replaces the plain URL text box */}
        <Field label="Destination  ·  where students land when they tap">
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-1.5" data-testid="push-dest-chips">
              {[
                { label: "📚  Library",     path: "/library",            desc: "Opens the book library" },
                { label: "🪙  My Points",   path: "/portal",             desc: "Opens the wallet & points balance" },
                { label: "🎰  Lucky Spin",  path: "/portal?tab=game",   desc: "Opens the lucky-spin game" },
                { label: "📊  My Scores",   path: "/portal?tab=scores", desc: "Opens speaking-lab scores" },
                { label: "💸  Send Points", path: "/portal?tab=send",   desc: "Opens the P2P points transfer" },
                { label: "🏠  Home",        path: "/",                   desc: "Opens the app home screen" },
              ].map(({ label: chipLabel, path, desc }) => {
                const active = url === path;
                return (
                  <button key={path} type="button"
                          onClick={() => setUrl(active ? "" : path)}
                          title={desc}
                          data-testid={`push-dest-chip-${path.replace(/[^a-z]/gi, "-")}`}
                          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all"
                          style={{
                            background: active ? css.aurora : "rgba(255,255,255,0.04)",
                            color:      active ? "#1a1420" : css.text,
                            border:     active ? "1px solid rgba(255,225,154,0.6)" : `1px solid ${css.border}`,
                            boxShadow:  active ? "0 4px 10px rgba(212,168,67,0.28)" : "none",
                          }}>
                    {chipLabel}
                  </button>
                );
              })}
            </div>
            <input value={url} onChange={(e) => setUrl(e.target.value)}
                   placeholder="or type a custom path, e.g. /library/read/my-book"
                   data-testid="push-url-input"
                   className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                   style={inputStyle} />
          </div>
        </Field>

        <Field label="Audience">
          <div className="flex gap-1.5 flex-wrap" data-testid="push-target-toggles">
            <TargetButton active={target === "everyone"} onClick={() => setTarget("everyone")}
                          icon={Globe} label="Everyone" testid="push-target-everyone" />
            <TargetButton active={target === "students"} onClick={() => setTarget("students")}
                          icon={Users} label="By Student ID" testid="push-target-students" />
            <TargetButton active={target === "group"} onClick={() => setTarget("group")}
                          icon={Hash} label="By Group" testid="push-target-group" />
          </div>
        </Field>

        {target === "students" && (
          <Field label="Student IDs  ·  comma- or space-separated">
            <textarea value={studentIdsRaw} rows={2}
                      onChange={(e) => setStudentIdsRaw(e.target.value)}
                      placeholder="stu001, stu002, stu003"
                      data-testid="push-studentids-input"
                      className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                      style={inputStyle} />
          </Field>
        )}

        {target === "group" && (
          <Field label="Group">
            <GroupPicker
              value={group}
              onChange={setGroup}
              groups={groups}
              loading={stuLoading}
              error={stuError}
              testid="push-group-picker"
            />
          </Field>
        )}

        {/* ---- audience count ----------------------------------------- */}
        <div className="text-[12px] flex items-center gap-2" data-testid="push-audience-count"
             style={{ color: css.textMuted }}>
          <Users className="h-3.5 w-3.5" />
          {countLoading
            ? "Counting subscribers…"
            : count == null
              ? "Audience unavailable"
              : <>About <strong style={{ color: css.text }}>{count}</strong> {count === 1 ? "student" : "students"} will receive this</>}
        </div>
        {target === "students" && studentIds.length > 0 && (
          <div
            data-testid="push-students-parsed"
            className="text-[11px] -mt-1.5"
            style={{ color: css.textMuted }}
          >
            Querying {studentIds.length} ID{studentIds.length === 1 ? "" : "s"}:{" "}
            <code style={{ color: css.text }}>{studentIds.join(", ")}</code>
            {count === 0 && (
              <span style={{ color: "#fca5a5" }}>
                {" "}· no subscriptions found (case-insensitive match)
              </span>
            )}
          </div>
        )}

        {/* ---- actions ------------------------------------------------- */}
        <div className="flex gap-2 flex-wrap pt-2">
          <button onClick={onSend} disabled={!canSend}
                  data-testid="push-send-btn"
                  className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider"
                  style={{
                    background: canSend ? css.aurora : "rgba(255,255,255,0.06)",
                    color: canSend ? "#1a1420" : css.textMuted,
                    border: "1px solid rgba(255,225,154,0.5)",
                    cursor: canSend ? "pointer" : "not-allowed",
                    opacity: canSend ? 1 : 0.6,
                  }}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send Now
          </button>

          {isSuperAdmin && (
            <button onClick={() => setScheduleOpen((v) => !v)}
                    data-testid="push-schedule-btn"
                    className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      color: css.text,
                      border: `1px solid ${css.borderStrong}`,
                    }}>
              <Calendar className="h-3.5 w-3.5" />
              {scheduleOpen ? "Cancel schedule" : "Schedule"}
            </button>
          )}
        </div>

        {scheduleOpen && (
          <div className="rounded-xl p-3 grid gap-2"
               data-testid="push-schedule-panel"
               style={{ background: css.card, border: `1px solid ${css.border}` }}>
            <label className="text-[11px] uppercase tracking-[0.18em]"
                   style={{ color: css.textMuted }}>Send at (your local time)</label>
            <input type="datetime-local"
                   value={sendAt}
                   onChange={(e) => setSendAt(e.target.value)}
                   data-testid="push-schedule-datetime"
                   className="rounded-lg px-3 py-2 text-[13px]"
                   style={{ ...inputStyle, colorScheme: "dark" }} />
            <button onClick={onSchedule} disabled={!canSchedule}
                    data-testid="push-schedule-confirm-btn"
                    className="self-start inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                    style={{
                      background: canSchedule ? css.aurora : "rgba(255,255,255,0.06)",
                      color: canSchedule ? "#1a1420" : css.textMuted,
                      border: "1px solid rgba(255,225,154,0.5)",
                      opacity: canSchedule ? 1 : 0.6,
                      cursor: canSchedule ? "pointer" : "not-allowed",
                    }}>
              <Calendar className="h-3 w-3" /> Confirm schedule
            </button>
          </div>
        )}

        {/* ---- result / error ---------------------------------------- */}
        {result && (
          <div data-testid="push-send-result"
               className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
               style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", color: "#bbf7d0" }}>
            <CheckCircle2 className="h-4 w-4" />
            Sent to {result.sent} student{result.sent === 1 ? "" : "s"} ({result.failed} failed)
          </div>
        )}
        {scheduleResult && (
          <div data-testid="push-schedule-result"
               className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
               style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.35)", color: "#bfdbfe" }}>
            <Calendar className="h-4 w-4" />
            Scheduled for {new Date(scheduleResult.sendAt).toLocaleString()}
          </div>
        )}
        {error && (
          <div data-testid="push-error"
               className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
               style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", color: "#fecaca" }}>
            <X className="h-4 w-4" /> {error}
          </div>
        )}
      </div>

      {/* ---- live preview ------------------------------------------------ */}
      <div data-testid="push-preview"
           className="rounded-2xl p-4 self-start"
           style={{ background: css.card, border: `1px solid ${css.border}` }}>
        <div className="text-[10px] uppercase tracking-[0.22em] mb-3"
             style={{ color: css.textMuted }}>Live preview</div>
        <div className="rounded-xl p-3"
             style={{ background: "rgba(20,20,28,0.95)", border: "1px solid rgba(255,255,255,0.07)",
                      boxShadow: "0 12px 28px rgba(0,0,0,0.45)" }}>
          <div className="flex gap-2.5">
            <div className="grid place-items-center h-9 w-9 rounded-lg shrink-0"
                 style={{ background: css.aurora }}>
              <Bell className="h-4 w-4" style={{ color: "#1a1420" }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <div className="text-[12.5px] font-bold truncate" style={{ color: "#fff" }}>
                  {title || "Notification title"}
                </div>
                <div className="text-[10px] shrink-0" style={{ color: "rgba(255,255,255,0.45)" }}>now</div>
              </div>
              <div className="text-[12px] mt-0.5 break-words" style={{ color: "rgba(255,255,255,0.78)" }}>
                {body || "Your message body will appear here."}
              </div>
              <div className="text-[10px] mt-1.5" style={{ color: "rgba(255,255,255,0.42)" }}>
                eduhub.app{url ? ` · ${url}` : ""}
              </div>
            </div>
          </div>
        </div>
        <div className="text-[10.5px] mt-2.5 leading-relaxed" style={{ color: css.textMuted }}>
          Static mockup — actual rendering depends on each student's OS notification style.
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Scheduled tab                                                               */
/* ========================================================================== */
function Scheduled({ isSuperAdmin }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await pushApi("/api/push/scheduled");
      setItems(r.items || []);
    } catch (e) {
      setError(e.message || "Load failed");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isSuperAdmin) reload(); }, [reload, isSuperAdmin]);

  const onDelete = async (id) => {
    if (!window.confirm("Delete this scheduled push?")) return;
    try {
      await pushApi(`/api/push/schedule/${id}`, { method: "DELETE" });
      setItems((arr) => arr.filter((x) => x.id !== id));
    } catch (e) {
      setError(e.message || "Delete failed");
    }
  };

  const onRunDue = async () => {
    setRunning(true); setError(null); setRunResult(null);
    try {
      const r = await pushApi("/api/push/schedule/run-due", { method: "POST" });
      setRunResult(r);
      await reload();
    } catch (e) {
      setError(e.message || "Run failed");
    } finally { setRunning(false); }
  };

  if (!isSuperAdmin) {
    return (
      <div data-testid="push-scheduled-locked"
           className="rounded-xl px-4 py-6 text-center text-[12.5px]"
           style={{ background: css.card, border: `1px solid ${css.border}`, color: css.textMuted }}>
        Only admins can view scheduled pushes.
      </div>
    );
  }

  return (
    <div data-testid="push-scheduled" className="grid gap-3">
      {/* ---- Feature 7: Weekly Progress Nudge preset ----------------- */}
      <WeeklyNudgePreset onScheduled={() => reload()} />

      <div className="flex items-center gap-2">
        <button onClick={onRunDue} disabled={running}
                data-testid="push-run-due-btn"
                className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "rgba(255,255,255,0.04)", color: css.text,
                         border: `1px solid ${css.borderStrong}` }}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Run due now
        </button>
        {runResult && (
          <span className="text-[11px]" style={{ color: css.textMuted }}>
            Processed {runResult.processed} job{runResult.processed === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && (
        <div data-testid="push-scheduled-error"
             className="rounded-xl px-3.5 py-2.5 text-[12px]"
             style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", color: "#fecaca" }}>
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton n={3} />
      ) : items.length === 0 ? (
        <Empty message="No scheduled pushes" testid="push-scheduled-empty" />
      ) : (
        <div className="grid gap-2">
          {items.map((it) => (
            <div key={it.id} data-testid={`push-scheduled-row-${it.id}`}
                 className="rounded-xl px-4 py-3 flex items-center gap-3"
                 style={{ background: css.card, border: `1px solid ${css.border}` }}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold truncate" style={{ color: css.text }}>
                  {it.title}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: css.textMuted }}>
                  {targetSummary(it)} · {fmtDate(it.sendAt)} · by {it.createdBy || "—"}
                </div>
              </div>
              <button onClick={() => onDelete(it.id)}
                      data-testid={`push-scheduled-delete-${it.id}`}
                      className="grid place-items-center h-8 w-8 rounded-lg"
                      style={{ background: "rgba(239,68,68,0.10)",
                               border: "1px solid rgba(239,68,68,0.35)",
                               color: css.danger }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* History tab                                                                 */
/* ========================================================================== */
const PAGE_SIZE = 50;

function HistoryView({ isSuperAdmin, userEmail }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await pushApi("/api/push/history", {
        qs: { limit: PAGE_SIZE, skip: page * PAGE_SIZE },
      });
      setItems(r.items || []);
      setTotal(r.total || 0);
    } catch (e) {
      setError(e.message || "Load failed");
    } finally { setLoading(false); }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div data-testid="push-history" className="grid gap-3">
      {error && (
        <div data-testid="push-history-error"
             className="rounded-xl px-3.5 py-2.5 text-[12px]"
             style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", color: "#fecaca" }}>
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton n={5} />
      ) : items.length === 0 ? (
        <Empty message="No push history yet" testid="push-history-empty" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl"
               style={{ background: css.card, border: `1px solid ${css.border}` }}>
            <table className="min-w-full text-[12px]" style={{ color: css.text }}>
              <thead style={{ color: css.textMuted, background: "rgba(255,255,255,0.02)" }}>
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Date / Time</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium text-right">Sent</th>
                  <th className="px-3 py-2 font-medium text-right">Failed</th>
                  {isSuperAdmin && <th className="px-3 py-2 font-medium">By</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const id = it.id || `row-${i}`;
                  const open = openId === id;
                  return (
                    <FragmentRow key={id} id={id} open={open}
                                 onToggle={() => setOpenId(open ? null : id)}
                                 it={it} isSuperAdmin={isSuperAdmin} />
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-[11px]" style={{ color: css.textMuted }}>
            <span data-testid="push-history-page-info">
              Page {page + 1} of {totalPages} · {total} record{total === 1 ? "" : "s"}
            </span>
            <div className="flex gap-1.5">
              <PagerBtn disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                        testid="push-history-prev"><ChevronLeft className="h-3 w-3" /> Prev</PagerBtn>
              <PagerBtn disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}
                        testid="push-history-next">Next <ChevronRight className="h-3 w-3" /></PagerBtn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FragmentRow({ id, open, onToggle, it, isSuperAdmin }) {
  return (
    <>
      <tr data-testid={`push-history-row-${id}`}
          onClick={onToggle}
          className="cursor-pointer"
          style={{ borderTop: `1px solid ${css.border}` }}>
        <td className="px-3 py-2 whitespace-nowrap" style={{ color: css.textMuted }}>{fmtDate(it.sentAt)}</td>
        <td className="px-3 py-2 font-medium">{it.title}</td>
        <td className="px-3 py-2" style={{ color: css.textMuted }}>{targetSummary(it)}</td>
        <td className="px-3 py-2 text-right">{it.sent ?? 0}</td>
        <td className="px-3 py-2 text-right" style={{ color: (it.failed || 0) > 0 ? "#fca5a5" : css.textMuted }}>{it.failed ?? 0}</td>
        {isSuperAdmin && <td className="px-3 py-2" style={{ color: css.textMuted }}>{it.sentBy || "—"}</td>}
      </tr>
      {open && (
        <tr data-testid={`push-history-row-detail-${id}`}
            style={{ background: "rgba(255,255,255,0.02)" }}>
          <td colSpan={isSuperAdmin ? 6 : 5} className="px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: css.textMuted }}>Body</div>
            <div className="text-[12.5px] mt-1">{it.body}</div>
            {it.url && (
              <>
                <div className="text-[11px] uppercase tracking-[0.18em] mt-2.5" style={{ color: css.textMuted }}>URL</div>
                <div className="text-[12.5px] mt-1 break-all" style={{ color: "#9ec5fe" }}>{it.url}</div>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ========================================================================== */
/* Quick Push tab — Feature 6 (Speaking results + custom single-student)       */
/* ========================================================================== */
function QuickPush({ isSuperAdmin }) {
  const [busy, setBusy] = useState(""); // "A" | "B" | "all" | "custom" | ""
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [studentId, setStudentId] = useState("");
  const [customMsg, setCustomMsg] = useState("");
  // v10.1 — load students for the picker
  const { students, loading: stuLoading, error: stuError } = useStudentList();

  const onSpeaking = async (group) => {
    setError(null); setResult(null); setBusy(group);
    try {
      const r = await pushApi("/api/teacher/push/speaking-results", {
        method: "POST", body: { group },
      });
      setResult({ kind: "speaking", group, ...r });
    } catch (e) {
      setError(e.message || "Send failed");
    } finally { setBusy(""); }
  };

  const onCustom = async () => {
    setError(null); setResult(null);
    const id = studentId.trim();
    const msg = customMsg.trim();
    if (!id) { setError("Student ID is required"); return; }
    setBusy("custom");
    try {
      const r = await pushApi(
        `/api/teacher/students/${encodeURIComponent(id)}/push-reminder`,
        { method: "POST", body: { message: msg } },
      );
      setResult({ kind: "custom", studentId: id, ...r });
    } catch (e) {
      setError(e.message || "Send failed");
    } finally { setBusy(""); }
  };

  if (!isSuperAdmin) {
    return (
      <div data-testid="push-quick-locked"
           className="rounded-xl px-4 py-6 text-center text-[12.5px]"
           style={{ background: css.card, border: `1px solid ${css.border}`, color: css.textMuted }}>
        Only admins can use Quick Push.
      </div>
    );
  }

  return (
    <div data-testid="push-quick" className="grid gap-5">
      {/* ---- Section 1: Speaking results ------------------------------ */}
      <section className="rounded-2xl p-4"
               style={{ background: css.card, border: `1px solid ${css.border}` }}>
        <div className="flex items-center gap-2 mb-1">
          <Zap className="h-3.5 w-3.5" style={{ color: "#D4A843" }} />
          <h3 className="text-[13px] font-semibold" style={{ color: css.text }}>
            Notify Speaking Results Ready
          </h3>
        </div>
        <p className="text-[11.5px] mb-3" style={{ color: css.textMuted }}>
          Sends a push to the chosen schedule group. Body:
          &ldquo;Your speaking test results are ready. Check your portal now!&rdquo;
        </p>
        <div className="flex gap-2 flex-wrap">
          <QuickBtn onClick={() => onSpeaking("A")} loading={busy === "A"}
                    testid="push-quick-speaking-A" label="Notify Schedule A" />
          <QuickBtn onClick={() => onSpeaking("B")} loading={busy === "B"}
                    testid="push-quick-speaking-B" label="Notify Schedule B" />
          <QuickBtn onClick={() => onSpeaking("all")} loading={busy === "all"}
                    testid="push-quick-speaking-all" label="Notify All" primary />
        </div>
      </section>

      {/* ---- Section 2: Custom single-student push -------------------- */}
      <section className="rounded-2xl p-4"
               style={{ background: css.card, border: `1px solid ${css.border}` }}>
        <div className="flex items-center gap-2 mb-1">
          <Send className="h-3.5 w-3.5" style={{ color: "#D4A843" }} />
          <h3 className="text-[13px] font-semibold" style={{ color: css.text }}>
            Custom Quick Push
          </h3>
        </div>
        <p className="text-[11.5px] mb-3" style={{ color: css.textMuted }}>
          Send a one-off push to a single student by ID. Reuses the tuition
          reminder endpoint with a custom message.
        </p>
        <div className="grid gap-3">
          <Field label="Student">
            <StudentPicker
              value={studentId}
              onChange={setStudentId}
              students={students}
              loading={stuLoading}
              error={stuError}
              testid="push-quick-student-picker"
            />
          </Field>
          <Field label={`Custom message  ·  ${customMsg.length}/200  ·  optional`}>
            <textarea value={customMsg} maxLength={200} rows={3}
                      onChange={(e) => setCustomMsg(e.target.value)}
                      placeholder="Leave empty to use the default tuition reminder text…"
                      data-testid="push-quick-custom-msg"
                      className="w-full rounded-xl px-3.5 py-2.5 text-[13px]"
                      style={inputStyle} />
          </Field>
          <div>
            <QuickBtn onClick={onCustom} loading={busy === "custom"}
                      testid="push-quick-custom-send"
                      label="Send to student" primary />
          </div>
        </div>
      </section>

      {/* ---- Result / error banners ---------------------------------- */}
      {result && result.kind === "speaking" && (
        <div data-testid="push-quick-result-speaking"
             className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
             style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", color: "#bbf7d0" }}>
          <CheckCircle2 className="h-4 w-4" />
          Speaking-results push sent · group {result.group} ·
          {" "}{result.sent ?? 0} delivered, {result.failed ?? 0} failed
        </div>
      )}
      {result && result.kind === "custom" && (
        <div data-testid="push-quick-result-custom"
             className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
             style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", color: "#bbf7d0" }}>
          <CheckCircle2 className="h-4 w-4" />
          Sent to {result.studentId} · {result.sent ?? 0} delivered,
          {" "}{result.failed ?? 0} failed
        </div>
      )}
      {error && (
        <div data-testid="push-quick-error"
             className="rounded-xl px-3.5 py-2.5 text-[12px] flex items-center gap-2"
             style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", color: "#fecaca" }}>
          <X className="h-4 w-4" /> {error}
        </div>
      )}
    </div>
  );
}

function QuickBtn({ onClick, loading, label, testid, primary = false }) {
  return (
    <button onClick={onClick} disabled={loading} data-testid={testid}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider"
            style={{
              background: primary ? css.aurora : "rgba(255,255,255,0.04)",
              color: primary ? "#1a1420" : css.text,
              border: primary ? "1px solid rgba(255,225,154,0.6)" : `1px solid ${css.borderStrong}`,
              opacity: loading ? 0.6 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}>
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

/* ========================================================================== */
/* Weekly Progress Nudge preset — Feature 7                                    */
/* ========================================================================== */
function WeeklyNudgePreset({ onScheduled }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const nextMondayEightAmISO = () => {
    const d = new Date();
    const day = d.getDay(); // 0 Sun … 6 Sat
    // Days until next Monday (8am). If today is Monday and it's still before 8am,
    // schedule today; otherwise next week's Monday.
    let daysAhead = (8 - day) % 7; // Monday = 1 -> ((8-1)%7)=0 means today
    const target = new Date(d);
    target.setHours(8, 0, 0, 0);
    if (daysAhead === 0 && d.getTime() >= target.getTime()) {
      daysAhead = 7;
    } else if (day !== 1) {
      // Recompute properly: get number of days until upcoming Monday
      daysAhead = (1 - day + 7) % 7;
      if (daysAhead === 0) daysAhead = 7;
    }
    target.setDate(d.getDate() + daysAhead);
    target.setHours(8, 0, 0, 0);
    return target.toISOString();
  };

  const onSchedule = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const sendAt = nextMondayEightAmISO();
      const payload = {
        title: "Weekly Progress Check",
        body: "Check your points, scores and library progress this week!",
        url: "/portal",
        target: "everyone",
        studentIds: [],
        group: "",
        sendAt,
        createdBy: "weekly-nudge-preset",
      };
      const r = await pushApi("/api/push/schedule", { method: "POST", body: payload });
      setResult({ sendAt: r.sendAt || sendAt });
      if (typeof onScheduled === "function") onScheduled();
    } catch (e) {
      setError(e.message || "Schedule failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl p-4"
         data-testid="push-weekly-nudge"
         style={{ background: css.card, border: `1px dashed ${css.borderStrong}` }}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="grid place-items-center h-9 w-9 rounded-xl shrink-0"
             style={{ background: "rgba(212,168,67,0.12)", border: "1px solid rgba(212,168,67,0.35)" }}>
          <TrendingUp className="h-4 w-4" style={{ color: "#D4A843" }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color: css.text }}>
            Weekly Progress Nudge
          </div>
          <div className="text-[11.5px] mt-0.5" style={{ color: css.textMuted }}>
            Schedules a one-off push for next Monday at 8:00 AM (your local time):
            &ldquo;Check your points, scores and library progress this week!&rdquo;
          </div>
        </div>
        <button onClick={onSchedule} disabled={busy}
                data-testid="push-weekly-nudge-btn"
                className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                style={{
                  background: busy ? "rgba(255,255,255,0.06)" : css.aurora,
                  color: busy ? css.textMuted : "#1a1420",
                  border: "1px solid rgba(255,225,154,0.6)",
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.7 : 1,
                }}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <TrendingUp className="h-3 w-3" />}
          Schedule Weekly Progress Nudge
        </button>
      </div>
      {result && (
        <div data-testid="push-weekly-nudge-result"
             className="mt-3 rounded-xl px-3.5 py-2 text-[11.5px] flex items-center gap-2"
             style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", color: "#bbf7d0" }}>
          <CheckCircle2 className="h-3.5 w-3.5" />
          Scheduled for {fmtDate(result.sendAt)}
        </div>
      )}
      {error && (
        <div data-testid="push-weekly-nudge-error"
             className="mt-3 rounded-xl px-3.5 py-2 text-[11.5px] flex items-center gap-2"
             style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", color: "#fecaca" }}>
          <X className="h-3.5 w-3.5" /> {error}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* SmartSampleGenerator — Feature 8 (Author Studio UI reconstruction, v11.0)   */
/* LOCAL template-based push message suggestions. No external API.             */
/* ========================================================================== */
function SmartSampleGenerator({ onApplySample }) {
  const [presetKey, setPresetKey] = useState("");
  const [appliedId, setAppliedId] = useState(null);

  const samples = useMemo(
    () => (presetKey ? generateSamples(presetKey) : []),
    [presetKey],
  );

  const handleApply = (s) => {
    if (typeof onApplySample === "function") onApplySample(s);
    setAppliedId(s.id);
    // Reset the "Applied ✓" badge after 1.6s so it feels confirmatory,
    // not sticky.
    setTimeout(() => setAppliedId(null), 1600);
  };

  return (
    <section
      data-testid="push-smart-suggest"
      className="rounded-2xl p-4"
      style={{
        background:
          "linear-gradient(160deg, rgba(212,168,67,0.08) 0%, rgba(255,255,255,0.03) 60%)",
        border: "1px solid rgba(212,168,67,0.28)",
      }}
    >
      <div className="flex items-start gap-3 mb-3">
        <div
          className="grid place-items-center h-9 w-9 rounded-xl shrink-0"
          style={{
            background: "rgba(212,168,67,0.15)",
            border: "1px solid rgba(212,168,67,0.4)",
          }}
        >
          <Wand2 className="h-4 w-4" style={{ color: "#D4A843" }} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-[13px] font-semibold"
            style={{ color: css.text }}
          >
            Smart Sample Generator
          </div>
          <div
            className="text-[11.5px] mt-0.5 leading-relaxed"
            style={{ color: css.textMuted }}
          >
            Pick an announcement type — we'll suggest student-friendly sample
            messages in English, Khmer, and bilingual.
            Tap <strong style={{ color: css.text }}>Use this sample</strong> to
            fill the form below — then edit and send manually.
          </div>
        </div>
      </div>

      {/* Preset chips — horizontal scroller on mobile, wraps on desktop */}
      <div
        className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 sm:flex-wrap sm:overflow-visible"
        style={{ scrollbarWidth: "thin" }}
        data-testid="push-smart-suggest-chips"
      >
        {PUSH_PRESETS.map((p) => {
          const active = p.key === presetKey;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setPresetKey(active ? "" : p.key);
                setAppliedId(null);
              }}
              data-testid={`push-smart-suggest-chip-${p.key}`}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition-all shrink-0"
              style={{
                background: active ? css.aurora : "rgba(255,255,255,0.04)",
                color: active ? "#1a1420" : css.text,
                border: active
                  ? "1px solid rgba(255,225,154,0.6)"
                  : `1px solid ${css.border}`,
                boxShadow: active
                  ? "0 4px 10px rgba(212,168,67,0.28)"
                  : "none",
              }}
            >
              <span>{p.emoji}</span>
              <span>{p.label}</span>
            </button>
          );
        })}
      </div>

      {/* Sample cards */}
      {presetKey && samples.length > 0 && (
        <div
          className="grid gap-2 mt-3"
          data-testid="push-smart-suggest-samples"
        >
          {samples.map((s) => {
            const applied = appliedId === s.id;
            return (
              <div
                key={s.id}
                data-testid={`push-smart-suggest-sample-${s.id}`}
                className="rounded-xl p-3 grid gap-2"
                style={{
                  background: "rgba(20,16,30,0.7)",
                  border: `1px solid ${css.border}`,
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                    style={{
                      background: "rgba(212,168,67,0.12)",
                      border: "1px solid rgba(212,168,67,0.35)",
                      color: "#D4A843",
                    }}
                  >
                    {LANG_LABELS[s.lang] || s.lang}
                  </span>
                  <span
                    className="text-[10.5px] uppercase tracking-[0.18em]"
                    style={{ color: css.textMuted }}
                  >
                    Sample
                  </span>
                </div>
                <div
                  className="text-[13px] font-semibold"
                  style={{ color: css.text }}
                >
                  {s.title}
                </div>
                <div
                  className="text-[12.5px] leading-relaxed"
                  style={{ color: "rgba(244,229,193,0.82)" }}
                >
                  {s.body}
                </div>
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <button
                    type="button"
                    onClick={() => handleApply(s)}
                    data-testid={`push-smart-suggest-apply-${s.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                    style={{
                      background: applied
                        ? "rgba(34,197,94,0.18)"
                        : css.aurora,
                      color: applied ? "#86efac" : "#1a1420",
                      border: applied
                        ? "1px solid rgba(34,197,94,0.45)"
                        : "1px solid rgba(255,225,154,0.6)",
                    }}
                  >
                    {applied ? (
                      <>
                        <CheckCircle2 className="h-3 w-3" /> Applied
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3 w-3" /> Use this sample
                      </>
                    )}
                  </button>
                  <span
                    className="text-[10.5px]"
                    style={{ color: css.textMuted }}
                  >
                    Fills Title + Message · you can still edit before sending
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!presetKey && (
        <div
          className="text-[11px] mt-2 px-1"
          style={{ color: css.textMuted }}
        >
          ↑ Pick a type to see sample messages. No push is sent automatically.
        </div>
      )}
    </section>
  );
}

/* ========================================================================== */
/* Bits                                                                        */
/* ========================================================================== */
function Field({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.22em]" style={{ color: css.textMuted }}>{label}</span>
      {children}
    </label>
  );
}

function TargetButton({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button onClick={onClick} data-testid={testid}
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
            style={{
              background: active ? css.aurora : "rgba(255,255,255,0.04)",
              color: active ? "#1a1420" : css.text,
              border: active ? "1px solid rgba(255,225,154,0.6)" : `1px solid ${css.border}`,
            }}>
      <Icon className="h-3 w-3" /> {label}
    </button>
  );
}

function PagerBtn({ children, disabled, onClick, testid }) {
  return (
    <button onClick={onClick} disabled={disabled} data-testid={testid}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wider"
            style={{
              background: "rgba(255,255,255,0.04)",
              color: disabled ? css.textMuted : css.text,
              border: `1px solid ${css.border}`,
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? "not-allowed" : "pointer",
            }}>
      {children}
    </button>
  );
}

function Skeleton({ n = 3 }) {
  return (
    <div className="grid gap-2" data-testid="push-skeleton">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-xl h-12"
             style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${css.border}` }} />
      ))}
    </div>
  );
}

function Empty({ message, testid }) {
  return (
    <div data-testid={testid}
         className="rounded-xl px-4 py-8 text-center text-[12.5px]"
         style={{ background: css.card, border: `1px dashed ${css.border}`, color: css.textMuted }}>
      {message}
    </div>
  );
}

/* ---- helpers --------------------------------------------------------- */
function targetSummary(it) {
  if (!it) return "";
  if (it.target === "everyone") return "Everyone";
  if (it.target === "students") {
    const n = (it.studentIds || []).length;
    return `${n} student${n === 1 ? "" : "s"}`;
  }
  if (it.target === "group") return `Group: ${it.group || "—"}`;
  return it.target || "";
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

const inputStyle = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${css.border}`,
  color: css.text,
  outline: "none",
};
