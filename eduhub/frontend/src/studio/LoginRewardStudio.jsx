/**
 * LoginRewardStudio.jsx — Author Studio panel for Login Reward Campaigns.
 *
 * Scope: brand-new, additive UI. Zero modifications to existing tools.
 *   • Create / edit / delete / enable-toggle login reward campaigns.
 *   • Professional calendar preset scheduler (today / tomorrow / weekend
 *     / 3-7-14 days / this month / custom) that auto-fills start/end.
 *   • Audience targeting (all / specific student IDs / exclusions).
 *   • Mobile-style live popup preview.
 *   • Backend is the source of truth for reward_points and eligibility —
 *     this file just edits the campaign config record.
 *
 * Reuses existing studio admin auth via studio/api.js (cookie + Bearer).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Gift, Plus, RefreshCw, Trash2, Edit3, Calendar as CalIcon,
  Eye, ToggleLeft, ToggleRight, AlertTriangle, CheckCircle2, X,
  Sparkles, Users, Clock, ChevronDown, ChevronUp, Info,
  Bell, Send, Loader2,
} from "lucide-react";
import {
  listLoginRewardCampaigns,
  createLoginRewardCampaign,
  updateLoginRewardCampaign,
  deleteLoginRewardCampaign,
  listLoginRewardClaims,
  sendLoginRewardCampaignPushNow,
} from "./api";

/* ── helpers ─────────────────────────────────────────────────────────── */
import ExperienceDesignerSection from "./rewardExperience/ExperienceDesignerSection";
import RewardExperiencePreview from "./rewardExperience/RewardExperiencePreview";
import {
  defaultExperience,
  normalizeExperience,
} from "../eduhub/components/rewardExperience/experienceThemes";

const TZ_LABEL = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; }
  catch { return "local"; }
})();

function pad(n) { return String(n).padStart(2, "0"); }

// Convert a Date to a "YYYY-MM-DDTHH:MM" string in LOCAL time (for <input type=datetime-local>).
function toLocalInput(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert a "YYYY-MM-DDTHH:MM" local-time string to an ISO UTC string.
function localInputToIso(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fmtRange(startIso, endIso) {
  if (!startIso || !endIso) return "—";
  try {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const opts = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
    return `${s.toLocaleString(undefined, opts)} → ${e.toLocaleString(undefined, opts)}`;
  } catch { return `${startIso} → ${endIso}`; }
}

function StatusBadge({ status }) {
  const map = {
    live:      { bg: "rgba(52,211,153,0.15)",  border: "rgba(52,211,153,0.45)", text: "#6ee7b7", label: "Live" },
    scheduled: { bg: "rgba(96,165,250,0.15)",  border: "rgba(96,165,250,0.4)",  text: "#93c5fd", label: "Scheduled" },
    expired:   { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.18)", text: "#9ca3af", label: "Expired" },
    disabled:  { bg: "rgba(255,100,100,0.10)", border: "rgba(255,100,100,0.3)",  text: "#fca5a5", label: "Disabled" },
  };
  const c = map[status] || map.disabled;
  return (
    <span data-testid={`lrc-status-badge-${status}`}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {c.label}
    </span>
  );
}

/* ── calendar presets ─────────────────────────────────────────────────── */
const PRESETS = [
  { key: "today",     label: "Today only" },
  { key: "tomorrow",  label: "Tomorrow only" },
  { key: "weekend",   label: "This weekend" },
  { key: "3d",        label: "3 days" },
  { key: "7d",        label: "7 days" },
  { key: "14d",       label: "14 days" },
  { key: "month",     label: "This month" },
  { key: "custom",    label: "Custom" },
];

function computePresetRange(key) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 0, 0); return x; };
  switch (key) {
    case "today":     return { start: now, end: endOfDay(now) };
    case "tomorrow": {
      const t = new Date(now); t.setDate(t.getDate() + 1);
      return { start: startOfDay(t), end: endOfDay(t) };
    }
    case "weekend": {
      const d = new Date(now);
      const day = d.getDay(); // 0=Sun..6=Sat
      const toSat = (6 - day + 7) % 7;
      const sat = new Date(d); sat.setDate(d.getDate() + toSat);
      const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
      return { start: startOfDay(sat), end: endOfDay(sun) };
    }
    case "3d": { const e = new Date(now); e.setDate(e.getDate() + 3); return { start: now, end: endOfDay(e) }; }
    case "7d": { const e = new Date(now); e.setDate(e.getDate() + 7); return { start: now, end: endOfDay(e) }; }
    case "14d": { const e = new Date(now); e.setDate(e.getDate() + 14); return { start: now, end: endOfDay(e) }; }
    case "month": {
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start: now, end: endOfDay(last) };
    }
    default: return null;
  }
}

/* ── blank form / defaults ────────────────────────────────────────────── */
function blankForm() {
  const now = new Date();
  const in7 = new Date(); in7.setDate(in7.getDate() + 7); in7.setHours(23, 59, 0, 0);
  return {
    id: null,
    name: "",
    enabled: false,                     // SAFETY: never auto-enabled
    notes: "",
    priority: 0,
    start_at: toLocalInput(now),
    end_at:   toLocalInput(in7),
    preset: "7d",
    reward_points: 20,
    reward_label: "",
    audience_type: "all",
    include_csv: "",
    exclude_csv: "",
    artwork_url: "",
    title: "Welcome back!",
    subtitle: "Claim your surprise learning points today.",
    cta_text: "Claim Reward",
    success_message: "Your reward has been credited!",
    accent_color: "#D4A843",
    dismiss_mode: "next_login",

    // Premium animation v1.1 — optional UI knobs (visual only). Defaults
    // mirror the popup defaults so existing campaigns keep working.
    animation_enabled: true,
    particle_intensity: "premium",   // "subtle" | "premium" | "celebration"
    countdown_enabled: false,
    countdown_mode: "none",          // "none" | "campaign_end" | "expires_after_open"
    countdown_seconds: 300,
    countdown_label: "Claim before it expires",
    urgency_text: "",

    // Reward-kind v1.0.2 — Points / Book Voucher / Points + Book Voucher.
    // Defaults to "points" so the form behaves exactly as before.
    reward_kind: "points",
    voucher_discount_type: "percent",   // "percent" | "fixed"
    voucher_discount_value: 20,
    voucher_max_uses: 1,                 // single-use personal voucher
    voucher_valid_days: 30,              // expiry = claim + N days (blank = use campaign end)
    voucher_book_slugs_csv: "",          // empty = works with all books
    voucher_title: "Book Voucher",
    voucher_subtitle: "",
    voucher_discount_label: "",          // auto-derived when blank
    voucher_template: "royal_purple_gold",
    voucher_accent_color: "#D4A843",
    voucher_artwork_url: "",
    voucher_cta_label: "Use Voucher",

    // Reward-kind v1.0.3 — coupon source: auto-create (default) or existing.
    voucher_source: "auto",          // "auto" | "existing"
    voucher_existing_code: "",

    // Smart Push Notification v1 — per-campaign push config. SAFE DEFAULTS:
    // disabled, empty copy, "eligible_unclaimed" so the admin never sends
    // anything by accident. Admin must enable + fill + click Send Push Now.
    push_enabled: false,
    push_title: "",
    push_body: "",
    push_target: "eligible_unclaimed", // "eligible_unclaimed" | "all_subscribers"

    // Reward Experience Engine v1 — presentational only. New campaigns get
    // the premium default; the reward engine never reads this field.
    experience: defaultExperience(),
  };
}

function campaignToForm(c) {
  return {
    id: c.id,
    name: c.name || "",
    enabled: !!c.enabled,
    notes: c.notes || "",
    priority: c.priority || 0,
    start_at: c.start_at ? toLocalInput(c.start_at) : toLocalInput(new Date()),
    end_at:   c.end_at   ? toLocalInput(c.end_at)   : toLocalInput(new Date(Date.now() + 7 * 86400000)),
    preset: "custom",
    reward_points: c.reward_points ?? 20,
    reward_label: c.reward_label || "",
    audience_type: c.audience_type || "all",
    include_csv: (c.include_student_ids || []).join(", "),
    exclude_csv: (c.exclude_student_ids || []).join(", "),
    artwork_url: c.artwork_url || "",
    title: c.title || "Welcome back!",
    subtitle: c.subtitle || "Claim your surprise learning points today.",
    cta_text: c.cta_text || "Claim Reward",
    success_message: c.success_message || "Your reward has been credited!",
    accent_color: c.accent_color || "#D4A843",
    dismiss_mode: c.dismiss_mode || "next_login",

    // Premium animation v1.1 — read with safe defaults so older records
    // (no animation/countdown fields) edit cleanly.
    animation_enabled: c.animation_enabled !== false,
    particle_intensity: c.particle_intensity || "premium",
    countdown_enabled: !!c.countdown_enabled,
    countdown_mode: c.countdown_mode || "none",
    countdown_seconds: typeof c.countdown_seconds === "number" ? c.countdown_seconds : 300,
    countdown_label: c.countdown_label || "Claim before it expires",
    urgency_text: c.urgency_text || "",

    // Reward-kind v1.0.2 — read with safe defaults so older points-only
    // records (no voucher fields) edit cleanly.
    reward_kind: c.reward_kind || "points",
    voucher_discount_type: c.voucher_discount_type || "percent",
    voucher_discount_value: c.voucher_discount_value ?? 20,
    voucher_max_uses: c.voucher_max_uses ?? 1,
    voucher_valid_days: c.voucher_valid_days ?? "",
    voucher_book_slugs_csv: (c.voucher_book_slugs || []).join(", "),
    voucher_title: c.voucher_title || "Book Voucher",
    voucher_subtitle: c.voucher_subtitle || "",
    voucher_discount_label: c.voucher_discount_label || "",
    voucher_template: c.voucher_template || "royal_purple_gold",
    voucher_accent_color: c.voucher_accent_color || "#D4A843",
    voucher_artwork_url: c.voucher_artwork_url || "",
    voucher_cta_label: c.voucher_cta_label || "Use Voucher",

    // Reward-kind v1.0.3 — coupon source.
    voucher_source: c.voucher_source || "auto",
    voucher_existing_code: c.voucher_existing_code || "",

    // Smart Push Notification v1 — read with safe defaults so older
    // campaigns (no push fields) edit cleanly.
    push_enabled: !!c.push_enabled,
    push_title: c.push_title || "",
    push_body: c.push_body || "",
    push_target: c.push_target || "eligible_unclaimed",

    // Reward Experience Engine v1 — campaigns saved before this feature
    // normalize to "classic" (legacy popup unchanged) until the admin
    // explicitly picks an environment.
    experience: normalizeExperience(c.experience),
  };
}

function formToPayload(f) {
  const rewardKind = f.reward_kind || "points";
  const isVoucherOnly = rewardKind === "voucher";
  return {
    name: f.name?.trim() || "Untitled campaign",
    enabled: !!f.enabled,
    notes: f.notes || "",
    priority: Number(f.priority) || 0,
    start_at: localInputToIso(f.start_at),
    end_at:   localInputToIso(f.end_at),
    timezone: TZ_LABEL,
    reward_type: "fixed",
    reward_kind: rewardKind,
    // Voucher-only campaigns don't award points — send 0 (the backend also
    // forces 0). Otherwise keep the legacy 1..1000 clamp.
    reward_points: isVoucherOnly ? 0 : Math.max(1, Math.min(1000, Number(f.reward_points) || 0)),
    reward_label: f.reward_label || "",
    audience_type: f.audience_type || "all",
    include_student_ids: f.include_csv || "",
    exclude_student_ids: f.exclude_csv || "",
    artwork_url: f.artwork_url || "",
    title: f.title || "",
    subtitle: f.subtitle || "",
    cta_text: f.cta_text || "Claim Reward",
    success_message: f.success_message || "",
    accent_color: f.accent_color || "#D4A843",
    dismiss_mode: f.dismiss_mode || "next_login",
    claim_limit_per_student: 1,

    // Premium animation v1.1 — additive optional fields. Backend treats
    // them as visual-only metadata; defaults match the popup.
    animation_enabled: !!f.animation_enabled,
    particle_intensity: f.particle_intensity || "premium",
    countdown_enabled: !!f.countdown_enabled,
    countdown_mode: f.countdown_mode || "none",
    countdown_seconds:
      f.countdown_mode === "expires_after_open"
        ? Math.max(5, Math.min(86400, Number(f.countdown_seconds) || 0))
        : null,
    countdown_label: (f.countdown_label || "").slice(0, 80),
    urgency_text: (f.urgency_text || "").slice(0, 140),

    // Reward-kind voucher sub-config v1.0.2. Only meaningful when the kind
    // includes a voucher; sent always so the backend persists a uniform shape.
    voucher_discount_type: f.voucher_discount_type || "percent",
    voucher_discount_value: Number(f.voucher_discount_value) || 0,
    voucher_max_uses:
      f.voucher_max_uses === "" || f.voucher_max_uses == null
        ? null
        : Math.max(1, Number(f.voucher_max_uses) || 1),
    voucher_valid_days:
      f.voucher_valid_days === "" || f.voucher_valid_days == null
        ? null
        : Math.max(1, Number(f.voucher_valid_days) || 1),
    voucher_book_slugs: f.voucher_book_slugs_csv || "",
    voucher_title: (f.voucher_title || "Book Voucher").slice(0, 80),
    voucher_subtitle: (f.voucher_subtitle || "").slice(0, 140),
    voucher_discount_label: (f.voucher_discount_label || "").slice(0, 60),
    voucher_template: f.voucher_template || "royal_purple_gold",
    voucher_accent_color: f.voucher_accent_color || "#D4A843",
    voucher_artwork_url: f.voucher_artwork_url || "",
    voucher_cta_label: (f.voucher_cta_label || "Use Voucher").slice(0, 40),

    // Reward-kind v1.0.3 — coupon source.
    voucher_source: f.voucher_source === "existing" ? "existing" : "auto",
    voucher_existing_code: (f.voucher_existing_code || "").trim().toUpperCase(),

    // Smart Push Notification v1 — persist admin's push settings on the
    // campaign so the editor remembers them and the "Send Push Now"
    // button has something to send. NEVER triggers an automatic send.
    push_enabled: !!f.push_enabled,
    push_title: (f.push_title || "").slice(0, 120),
    push_body: (f.push_body || "").slice(0, 500),
    push_target:
      f.push_target === "all_subscribers" ? "all_subscribers" : "eligible_unclaimed",

    // Reward Experience Engine v1 — additive presentational config.
    experience: f.experience ? normalizeExperience(f.experience) : null,
  };
}


/* ── main panel ──────────────────────────────────────────────────────── */
export default function LoginRewardStudio() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(null); // form
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await listLoginRewardCampaigns();
      const items = (data?.campaigns || []).slice().sort((a, b) => {
        const pa = a.priority || 0, pb = b.priority || 0;
        if (pa !== pb) return pb - pa;
        return (b.created_at || "").localeCompare(a.created_at || "");
      });
      setList(items);
    } catch (e) {
      setError(e?.message || "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startCreate = () => { setEditing(blankForm()); setShowForm(true); setSaveError(null); };
  const startEdit   = (c) => { setEditing(campaignToForm(c)); setShowForm(true); setSaveError(null); };
  const cancelForm  = () => { setShowForm(false); setEditing(null); setSaveError(null); };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true); setSaveError(null);
    try {
      // local validation
      if (!editing.name?.trim()) throw new Error("Campaign name is required.");
      const startIso = localInputToIso(editing.start_at);
      const endIso = localInputToIso(editing.end_at);
      if (!startIso || !endIso) throw new Error("Please set both start and end date/time.");
      if (new Date(endIso) <= new Date(startIso)) throw new Error("End must be after start.");

      // Reward-kind v1.0.2 — validation depends on the reward kind.
      const rewardKind = editing.reward_kind || "points";
      if (rewardKind !== "voucher") {
        const pts = Number(editing.reward_points);
        if (!Number.isFinite(pts) || pts <= 0 || pts > 1000) throw new Error("Reward points must be between 1 and 1000.");
      }
      if (rewardKind === "voucher" || rewardKind === "points_voucher") {
        if ((editing.voucher_source || "auto") === "existing") {
          if (!(editing.voucher_existing_code || "").trim()) {
            throw new Error("Enter an existing coupon code, or switch to auto-create.");
          }
        } else {
          const dv = Number(editing.voucher_discount_value);
          if (!Number.isFinite(dv) || dv <= 0) throw new Error("Voucher discount value must be greater than 0.");
          if ((editing.voucher_discount_type || "percent") === "percent" && dv > 100) {
            throw new Error("A percent voucher discount cannot exceed 100.");
          }
        }
      }

      const payload = formToPayload(editing);
      if (editing.id) {
        await updateLoginRewardCampaign(editing.id, payload);
        setToast({ kind: "ok", msg: "Campaign updated." });
      } else {
        await createLoginRewardCampaign(payload);
        setToast({ kind: "ok", msg: "Campaign created (disabled by default)." });
      }
      setShowForm(false); setEditing(null);
      await load();
      setTimeout(() => setToast(null), 2800);
    } catch (e) {
      setSaveError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (c) => {
    try {
      const payload = formToPayload({ ...campaignToForm(c), enabled: !c.enabled });
      await updateLoginRewardCampaign(c.id, payload);
      setToast({ kind: "ok", msg: !c.enabled ? "Campaign enabled — live for eligible students." : "Campaign disabled." });
      await load();
      setTimeout(() => setToast(null), 2800);
    } catch (e) {
      setToast({ kind: "err", msg: e?.message || "Toggle failed" });
      setTimeout(() => setToast(null), 3200);
    }
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete campaign "${c.name}"? This cannot be undone.`)) return;
    try {
      await deleteLoginRewardCampaign(c.id);
      setToast({ kind: "ok", msg: "Campaign deleted." });
      await load();
      setTimeout(() => setToast(null), 2800);
    } catch (e) {
      setToast({ kind: "err", msg: e?.message || "Delete failed" });
      setTimeout(() => setToast(null), 3200);
    }
  };

  return (
    <div className="text-parchment" data-testid="login-reward-studio">
      <header className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-gold" />
          <h2 className="font-display text-lg">Login Rewards</h2>
          <span className="text-[11px] text-faded">Controlled campaigns · backend-credited</span>
        </div>
        <div className="flex-1" />
        <button onClick={load} data-testid="lrc-refresh-btn"
                className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        <button onClick={startCreate} data-testid="lrc-new-btn"
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
          <Plus className="h-3.5 w-3.5" /> New campaign
        </button>
      </header>

      {toast && (
        <div data-testid="lrc-toast"
             className="mb-3 rounded-xl px-3 py-2 text-[12px]"
             style={{
               background: toast.kind === "ok" ? "rgba(52,211,153,0.12)" : "rgba(255,100,100,0.12)",
               border: `1px solid ${toast.kind === "ok" ? "rgba(52,211,153,0.4)" : "rgba(255,100,100,0.4)"}`,
               color: toast.kind === "ok" ? "#6ee7b7" : "#fca5a5",
             }}>
          {toast.kind === "ok" ? <CheckCircle2 className="inline h-4 w-4 mr-1" /> : <AlertTriangle className="inline h-4 w-4 mr-1" />}
          {toast.msg}
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-xl px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", border: "1px solid rgba(255,100,100,0.3)", color: "#fca5a5" }}>
          <AlertTriangle className="inline h-4 w-4 mr-1" /> {error}
        </div>
      )}

      {showForm && editing && (
        <CampaignForm
          form={editing}
          setForm={setEditing}
          onCancel={cancelForm}
          onSave={handleSave}
          saving={saving}
          saveError={saveError}
        />
      )}

      <section className="space-y-2">
        {loading ? (
          <div className="text-[12px] text-faded">Loading campaigns…</div>
        ) : list.length === 0 ? (
          <EmptyState onCreate={startCreate} />
        ) : (
          list.map((c) => (
            <CampaignRow key={c.id} c={c}
                         onEdit={() => startEdit(c)}
                         onToggle={() => handleToggle(c)}
                         onDelete={() => handleDelete(c)} />
          ))
        )}
      </section>
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div className="rounded-2xl border border-dashed border-parchment/15 p-8 text-center"
         data-testid="lrc-empty-state">
      <Sparkles className="h-7 w-7 text-gold mx-auto" />
      <h3 className="font-display text-[18px] mt-2">No campaigns yet</h3>
      <p className="text-[12px] text-faded max-w-sm mx-auto mt-1">
        Login Rewards are special, controlled campaigns (usually 1–2 per month) that
        nudge students back into the PWA. Create one, leave it <em>disabled</em> until
        you're ready, then flip it live when the popup is approved.
      </p>
      <button onClick={onCreate} data-testid="lrc-empty-create-btn"
              className="mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
        <Plus className="h-3.5 w-3.5" /> Create first campaign
      </button>
    </div>
  );
}

function CampaignRow({ c, onEdit, onToggle, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [claims, setClaims] = useState(null);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const loadClaims = useCallback(async () => {
    setClaimsLoading(true);
    try {
      const data = await listLoginRewardClaims(c.id);
      setClaims(data?.claims || []);
    } catch (e) {
      setClaims([]);
    } finally { setClaimsLoading(false); }
  }, [c.id]);

  useEffect(() => { if (expanded && claims === null) loadClaims(); }, [expanded, claims, loadClaims]);

  return (
    <div className="rounded-2xl border border-white/8 bg-walnut/40 p-3" data-testid={`lrc-row-${c.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={c.status} />
            <div className="text-[13px] font-bold text-parchment">{c.name || "Untitled campaign"}</div>
            <span className="text-[10px] text-faded">#{c.id}</span>
          </div>
          <div className="text-[11px] text-faded mt-1 flex items-center gap-1.5 flex-wrap">
            <CalIcon className="h-3 w-3" />
            <span>{fmtRange(c.start_at, c.end_at)}</span>
            <span className="opacity-50">·</span>
            <span>+{c.reward_points} PTS</span>
            <span className="opacity-50">·</span>
            <span>{c.title || ""}</span>
          </div>
        </div>
        <button onClick={onToggle} data-testid={`lrc-toggle-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-parchment/20 bg-walnut/70 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          {c.enabled
            ? (<><ToggleRight className="h-3.5 w-3.5 text-green-400" /> Enabled</>)
            : (<><ToggleLeft className="h-3.5 w-3.5" /> Disabled</>)}
        </button>
        <button onClick={() => setExpanded((v) => !v)} data-testid={`lrc-expand-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-parchment/20 bg-walnut/70 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? "Hide" : "Claims"}
        </button>
        <button onClick={onEdit} data-testid={`lrc-edit-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-parchment/20 bg-walnut/70 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <Edit3 className="h-3.5 w-3.5" /> Edit
        </button>
        <button onClick={onDelete} data-testid={`lrc-delete-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-red-300/30 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-red-300 hover:bg-red-500/10">
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-white/8 pt-3 text-[12px]" data-testid={`lrc-claims-panel-${c.id}`}>
          <div className="font-bold text-parchment text-[11.5px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-gold" /> Claims
          </div>
          {claimsLoading ? (
            <div className="text-faded">Loading claims…</div>
          ) : (claims && claims.length > 0) ? (
            <div className="space-y-1">
              {claims.map((cl, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[11px]"
                     data-testid={`lrc-claim-row-${i}`}>
                  <span className="font-mono text-parchment">{cl.student_id}</span>
                  <span className="text-faded">{cl.claimed_at}</span>
                  <span className="text-gold font-bold">+{cl.points_awarded} PTS</span>
                  <span className="text-[10px] text-faded uppercase">{cl.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-faded">No claims yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── form component ──────────────────────────────────────────────────── */
function CampaignForm({ form, setForm, onCancel, onSave, saving, saveError }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const applyPreset = (key) => {
    set("preset", key);
    if (key === "custom") return;
    const r = computePresetRange(key);
    if (!r) return;
    set("start_at", toLocalInput(r.start));
    set("end_at", toLocalInput(r.end));
  };

  const livePreview = useMemo(() => ({ ...form }), [form]);

  // Live status preview (front-end only)
  const status = useMemo(() => {
    if (!form.enabled) return "disabled";
    const s = new Date(form.start_at);
    const e = new Date(form.end_at);
    const n = new Date();
    if (n < s) return "scheduled";
    if (n > e) return "expired";
    return "live";
  }, [form.enabled, form.start_at, form.end_at]);

  return (
    <div className="rounded-2xl border border-gold/25 bg-walnut/50 p-4 mb-5"
         data-testid="lrc-campaign-form">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px]">{form.id ? "Edit campaign" : "New campaign"}</h3>
        <StatusBadge status={status} />
        <div className="flex-1" />
        <button onClick={onCancel} data-testid="lrc-form-close"
                className="inline-flex items-center gap-1 rounded-full border border-parchment/20 bg-walnut/70 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <X className="h-3.5 w-3.5" /> Close
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5">
        {/* LEFT — fields */}
        <div className="space-y-4 min-w-0">
          {/* Basics */}
          <fieldset className="space-y-2">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1">Basics</legend>
            <label className="block">
              <span className="text-[11px] text-faded">Campaign name</span>
              <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)}
                     data-testid="lrc-input-name"
                     className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-faded">Priority</span>
                <input type="number" value={form.priority}
                       onChange={(e) => set("priority", Number(e.target.value) || 0)}
                       data-testid="lrc-input-priority"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
              <label className="flex items-end gap-2">
                <input type="checkbox" checked={!!form.enabled} onChange={(e) => set("enabled", e.target.checked)}
                       data-testid="lrc-input-enabled"
                       className="h-4 w-4 accent-amber-400" />
                <span className="text-[12px] text-parchment">Enabled</span>
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] text-faded">Internal notes (optional)</span>
              <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
                        data-testid="lrc-input-notes"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[12px] text-parchment focus:outline-none focus:border-gold" />
            </label>
          </fieldset>

          {/* Schedule */}
          <fieldset className="space-y-2">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1 flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Schedule
              <span className="text-faded text-[10px] normal-case ml-1">tz: {TZ_LABEL}</span>
            </legend>
            <div className="flex flex-wrap gap-1.5" data-testid="lrc-presets">
              {PRESETS.map((p) => (
                <button key={p.key} onClick={() => applyPreset(p.key)}
                        data-testid={`lrc-preset-${p.key}`}
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider transition-all"
                        style={{
                          background: form.preset === p.key
                            ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                            : "rgba(45,31,62,0.65)",
                          color: form.preset === p.key ? "#1a1420" : "#F4E5C1",
                          border: form.preset === p.key ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
                        }}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-faded">Start</span>
                <input type="datetime-local" value={form.start_at}
                       onChange={(e) => { set("start_at", e.target.value); set("preset", "custom"); }}
                       data-testid="lrc-input-start"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
              <label className="block">
                <span className="text-[11px] text-faded">End</span>
                <input type="datetime-local" value={form.end_at}
                       onChange={(e) => { set("end_at", e.target.value); set("preset", "custom"); }}
                       data-testid="lrc-input-end"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
            </div>
            <div className="text-[11px] text-faded" data-testid="lrc-window-preview">
              Active window: <span className="text-parchment">{fmtRange(localInputToIso(form.start_at), localInputToIso(form.end_at))}</span>
            </div>
          </fieldset>

          {/* Reward */}
          <fieldset className="space-y-2">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1">Reward</legend>

            {/* Reward-kind v1.0.2 — choose what this campaign hands out. */}
            <div>
              <span className="text-[11px] text-faded">Reward kind</span>
              <div className="mt-1 grid grid-cols-3 gap-2" data-testid="lrc-reward-kind">
                {[
                  ["points", "Points"],
                  ["voucher", "Book Voucher"],
                  ["points_voucher", "Points + Voucher"],
                ].map(([val, label]) => {
                  const active = (form.reward_kind || "points") === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => set("reward_kind", val)}
                      data-testid={`lrc-reward-kind-${val}`}
                      className={
                        "rounded-lg border px-2 py-2 text-[11px] font-bold transition " +
                        (active
                          ? "border-gold bg-gold/20 text-gold"
                          : "border-parchment/15 bg-black/30 text-faded hover:border-gold/40")
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {(form.reward_kind || "points") !== "voucher" && (
                <label className="block">
                  <span className="text-[11px] text-faded">Points (1–1000)</span>
                  <input type="number" min={1} max={1000} value={form.reward_points}
                         onChange={(e) => set("reward_points", e.target.value)}
                         data-testid="lrc-input-points"
                         className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  <span className="text-[10px] text-faded">Recommended: 10 / 20 / 30</span>
                </label>
              )}
              <label className="block">
                <span className="text-[11px] text-faded">Reward label (optional)</span>
                <input type="text" value={form.reward_label}
                       onChange={(e) => set("reward_label", e.target.value)}
                       data-testid="lrc-input-label"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
            </div>

            {/* Voucher configuration — only when the kind includes a voucher. */}
            {((form.reward_kind || "points") === "voucher" ||
              (form.reward_kind || "points") === "points_voucher") && (
              <div
                className="mt-2 rounded-xl border border-gold/25 bg-black/20 p-3 space-y-3"
                data-testid="lrc-voucher-config"
              >
                <div className="text-[10.5px] uppercase tracking-wider text-gold font-bold">
                  Book Voucher
                </div>

                {/* Coupon source v1.0.3 — auto-create (default) or existing. */}
                <div>
                  <span className="text-[11px] text-faded">Coupon source</span>
                  <div className="mt-1 grid grid-cols-2 gap-2" data-testid="lrc-voucher-source">
                    {[
                      ["auto", "Auto-create unique"],
                      ["existing", "Use existing coupon"],
                    ].map(([val, label]) => {
                      const active = (form.voucher_source || "auto") === val;
                      return (
                        <button
                          key={val}
                          type="button"
                          onClick={() => set("voucher_source", val)}
                          data-testid={`lrc-voucher-source-${val}`}
                          className={
                            "rounded-lg border px-2 py-2 text-[11px] font-bold transition " +
                            (active
                              ? "border-gold bg-gold/20 text-gold"
                              : "border-parchment/15 bg-black/30 text-faded hover:border-gold/40")
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {(form.voucher_source || "auto") === "existing" && (
                  <label className="block">
                    <span className="text-[11px] text-faded">Existing coupon code</span>
                    <input type="text" value={form.voucher_existing_code}
                           onChange={(e) => set("voucher_existing_code", e.target.value.toUpperCase())}
                           placeholder="e.g. WELCOME20 (must already exist)"
                           data-testid="lrc-voucher-existing-code"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                    <span className="text-[10px] text-amber-300/90 leading-relaxed block mt-1">
                      The same code is shared with every recipient and is governed by that
                      coupon's own discount, max-uses, expiry, and assignment. For a campaign
                      with many students, make sure the coupon's max-uses is high enough — a
                      single-use coupon can only be redeemed once. (A failed/exhausted redeem
                      is blocked at checkout, so no unlock happens without a successful redeem.)
                    </span>
                  </label>
                )}

                {(form.voucher_source || "auto") === "auto" && (
                <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-faded">Discount type</span>
                    <select value={form.voucher_discount_type}
                            onChange={(e) => set("voucher_discount_type", e.target.value)}
                            data-testid="lrc-voucher-type"
                            className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold">
                      <option value="percent">Percent (%)</option>
                      <option value="fixed">Fixed (points)</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">
                      Discount value {form.voucher_discount_type === "fixed" ? "(pts)" : "(%)"}
                    </span>
                    <input type="number" min={1}
                           max={form.voucher_discount_type === "percent" ? 100 : undefined}
                           value={form.voucher_discount_value}
                           onChange={(e) => set("voucher_discount_value", e.target.value)}
                           data-testid="lrc-voucher-value"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-faded">Valid for (days)</span>
                    <input type="number" min={1} value={form.voucher_valid_days}
                           onChange={(e) => set("voucher_valid_days", e.target.value)}
                           placeholder="blank = until campaign end"
                           data-testid="lrc-voucher-days"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">Max uses</span>
                    <input type="number" min={1} value={form.voucher_max_uses}
                           onChange={(e) => set("voucher_max_uses", e.target.value)}
                           placeholder="1 (single-use)"
                           data-testid="lrc-voucher-maxuses"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                </div>

                <label className="block">
                  <span className="text-[11px] text-faded">Eligible book slugs (comma-separated)</span>
                  <input type="text" value={form.voucher_book_slugs_csv}
                         onChange={(e) => set("voucher_book_slugs_csv", e.target.value)}
                         placeholder="leave blank = works with all books"
                         data-testid="lrc-voucher-books"
                         className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  <span className="text-[10px] text-faded">Blank = valid on every book.</span>
                </label>
                </>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-faded">Voucher title</span>
                    <input type="text" value={form.voucher_title}
                           onChange={(e) => set("voucher_title", e.target.value)}
                           data-testid="lrc-voucher-title"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">Discount label (optional)</span>
                    <input type="text" value={form.voucher_discount_label}
                           onChange={(e) => set("voucher_discount_label", e.target.value)}
                           placeholder="auto, e.g. 20% off"
                           data-testid="lrc-voucher-label"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                </div>

                <label className="block">
                  <span className="text-[11px] text-faded">Voucher subtitle (optional)</span>
                  <input type="text" value={form.voucher_subtitle}
                         onChange={(e) => set("voucher_subtitle", e.target.value)}
                         data-testid="lrc-voucher-subtitle"
                         className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-faded">Template</span>
                    <select value={form.voucher_template}
                            onChange={(e) => set("voucher_template", e.target.value)}
                            data-testid="lrc-voucher-template"
                            className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold">
                      <option value="royal_purple_gold">Royal Purple &amp; Gold</option>
                      <option value="ocean_blue_glass">Ocean Blue Glass</option>
                      <option value="emerald_learning_pass">Emerald Learning Pass</option>
                      <option value="black_diamond_premium">Black Diamond Premium</option>
                      <option value="warm_ivory_gift_card">Warm Ivory Gift Card</option>
                      <option value="festival_celebration">Festival Celebration</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">Accent color</span>
                    <input type="text" value={form.voucher_accent_color}
                           onChange={(e) => set("voucher_accent_color", e.target.value)}
                           placeholder="#D4A843"
                           data-testid="lrc-voucher-accent"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-faded">Artwork URL (https only, optional)</span>
                    <input type="text" value={form.voucher_artwork_url}
                           onChange={(e) => set("voucher_artwork_url", e.target.value)}
                           placeholder="https://… (blank = use template)"
                           data-testid="lrc-voucher-artwork"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">Use-voucher button text</span>
                    <input type="text" value={form.voucher_cta_label}
                           onChange={(e) => set("voucher_cta_label", e.target.value)}
                           data-testid="lrc-voucher-cta"
                           className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
                  </label>
                </div>

                <p className="text-[10px] text-faded leading-relaxed">
                  The voucher is issued as a real, single-use coupon when the student claims,
                  and is redeemed through the normal Library checkout. Artwork must be an
                  https:// image URL; otherwise the template gradient is used.
                </p>
              </div>
            )}
          </fieldset>

          {/* Audience */}
          <fieldset className="space-y-2">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> Audience
            </legend>
            <div className="flex gap-2 flex-wrap" data-testid="lrc-audience-options">
              {[
                { k: "all", label: "All students" },
                { k: "specific_students", label: "Specific IDs only" },
                { k: "exclude_only", label: "Exclude specific IDs" },
              ].map((opt) => (
                <button key={opt.k} onClick={() => set("audience_type", opt.k)}
                        data-testid={`lrc-aud-${opt.k}`}
                        className="rounded-full px-3 py-1 text-[10.5px] font-bold uppercase tracking-wider"
                        style={{
                          background: form.audience_type === opt.k
                            ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                            : "rgba(45,31,62,0.65)",
                          color: form.audience_type === opt.k ? "#1a1420" : "#F4E5C1",
                          border: form.audience_type === opt.k ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
                        }}>
                  {opt.label}
                </button>
              ))}
            </div>
            {(form.audience_type === "specific_students") && (
              <label className="block">
                <span className="text-[11px] text-faded">Include student IDs (comma-separated)</span>
                <textarea rows={2} value={form.include_csv}
                          onChange={(e) => set("include_csv", e.target.value)}
                          placeholder="stu093, stu094, stu105"
                          data-testid="lrc-input-include"
                          className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[12px] text-parchment focus:outline-none focus:border-gold" />
                <span className="text-[10px] text-faded">IDs are case-insensitive (stu093 = STU093).</span>
              </label>
            )}
            <label className="block">
              <span className="text-[11px] text-faded">Exclude student IDs (comma-separated, optional)</span>
              <textarea rows={2} value={form.exclude_csv}
                        onChange={(e) => set("exclude_csv", e.target.value)}
                        placeholder="stu101"
                        data-testid="lrc-input-exclude"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[12px] text-parchment focus:outline-none focus:border-gold" />
            </label>
          </fieldset>

          {/* Artwork + content */}
          <fieldset className="space-y-2">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1">Popup content</legend>
            <label className="block">
              <span className="text-[11px] text-faded">Title</span>
              <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)}
                     data-testid="lrc-input-title"
                     className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
            </label>
            <label className="block">
              <span className="text-[11px] text-faded">Subtitle</span>
              <textarea rows={2} value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)}
                        data-testid="lrc-input-subtitle"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[12px] text-parchment focus:outline-none focus:border-gold" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-faded">CTA / button text</span>
                <input type="text" value={form.cta_text} onChange={(e) => set("cta_text", e.target.value)}
                       data-testid="lrc-input-cta"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
              <label className="block">
                <span className="text-[11px] text-faded">Success message</span>
                <input type="text" value={form.success_message}
                       onChange={(e) => set("success_message", e.target.value)}
                       data-testid="lrc-input-success"
                       className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] text-faded">Artwork URL (SVG/PNG/JPG/WebP/GIF, optional)</span>
              <input type="url" value={form.artwork_url} onChange={(e) => set("artwork_url", e.target.value)}
                     placeholder="https://example.com/reward.svg"
                     data-testid="lrc-input-artwork"
                     className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              <span className="text-[10px] text-faded">Rendered safely via &lt;img&gt; — never injected as HTML.</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-faded">Accent color</span>
                <input type="color" value={form.accent_color}
                       onChange={(e) => set("accent_color", e.target.value)}
                       data-testid="lrc-input-accent"
                       className="mt-1 w-12 h-8 rounded bg-black/30 border border-parchment/15" />
              </label>
              <label className="block">
                <span className="text-[11px] text-faded">Dismiss behavior</span>
                <select value={form.dismiss_mode} onChange={(e) => set("dismiss_mode", e.target.value)}
                        data-testid="lrc-input-dismiss"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold">
                  <option value="next_login">Show again next login</option>
                  <option value="after_24h">Show again after 24h</option>
                </select>
              </label>
            </div>
          </fieldset>

          {/* Effects & Urgency (Premium animation v1.1 — optional, additive) */}
          <fieldset className="space-y-2" data-testid="lrc-effects-fieldset">
            <legend className="text-[10.5px] uppercase tracking-wider text-gold font-bold mb-1 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Effects & urgency
              <span className="text-faded text-[10px] normal-case ml-1">all optional</span>
            </legend>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!form.animation_enabled}
                  onChange={(e) => set("animation_enabled", e.target.checked)}
                  data-testid="lrc-input-animation-enabled"
                  className="h-4 w-4 accent-amber-400"
                />
                <span className="text-[12px] text-parchment">Popup animation effects</span>
              </label>
              <label className="block">
                <span className="text-[11px] text-faded">Particle intensity</span>
                <select
                  value={form.particle_intensity}
                  onChange={(e) => set("particle_intensity", e.target.value)}
                  data-testid="lrc-input-particle-intensity"
                  className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                >
                  <option value="subtle">Subtle</option>
                  <option value="premium">Premium</option>
                  <option value="celebration">Celebration</option>
                </select>
              </label>
            </div>

            <div className="border-t border-white/8 pt-3 mt-2 space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!form.countdown_enabled}
                  onChange={(e) => set("countdown_enabled", e.target.checked)}
                  data-testid="lrc-input-countdown-enabled"
                  className="h-4 w-4 accent-amber-400"
                />
                <span className="text-[12px] text-parchment">Countdown timer (off by default)</span>
              </label>

              {form.countdown_enabled && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] text-faded">Countdown mode</span>
                      <select
                        value={form.countdown_mode}
                        onChange={(e) => set("countdown_mode", e.target.value)}
                        data-testid="lrc-input-countdown-mode"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                      >
                        <option value="none">None (hide timer)</option>
                        <option value="campaign_end">To campaign end (backend-enforced)</option>
                        <option value="expires_after_open">After popup open (visual only)</option>
                      </select>
                    </label>
                    {form.countdown_mode === "expires_after_open" && (
                      <label className="block">
                        <span className="text-[11px] text-faded">Seconds after open (5–86400)</span>
                        <input
                          type="number"
                          min={5}
                          max={86400}
                          value={form.countdown_seconds}
                          onChange={(e) => set("countdown_seconds", Number(e.target.value) || 0)}
                          data-testid="lrc-input-countdown-seconds"
                          className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                        />
                      </label>
                    )}
                  </div>

                  <label className="block">
                    <span className="text-[11px] text-faded">Countdown label (max 80 chars)</span>
                    <input
                      type="text"
                      value={form.countdown_label}
                      onChange={(e) => set("countdown_label", e.target.value)}
                      maxLength={80}
                      placeholder="Claim before it expires"
                      data-testid="lrc-input-countdown-label"
                      className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-faded">Urgency text (optional, max 140 chars)</span>
                    <input
                      type="text"
                      value={form.urgency_text}
                      onChange={(e) => set("urgency_text", e.target.value)}
                      maxLength={140}
                      placeholder="Last few hours!"
                      data-testid="lrc-input-urgency-text"
                      className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                    />
                  </label>

                  <p className="text-[10.5px] text-faded leading-relaxed">
                    <Info className="inline h-3 w-3 mr-1" />
                    <strong>“To campaign end”</strong> aligns with the backend-enforced
                    expiry (claim auto-disables at 0). <strong>“After popup open”</strong>{" "}
                    is <em>visual-only</em>; the timer hides at 0 and claim stays available.
                  </p>
                </>
              )}
            </div>
          </fieldset>

          {/* Reward Experience Engine v1 — visual experience designer.
              Edits only form.experience (presentational). */}
          <ExperienceDesignerSection form={form} set={set} />

          {/* Smart Push Notification v1 — collapsible fieldset. Persists with
              the campaign but never auto-sends. Admin clicks "Send Push Now"
              to fire via the existing /api/push/* fan-out. */}
          <PushNotificationFieldset form={form} set={set} campaignId={form.id} />

          {saveError && (
            <div className="rounded-lg px-3 py-2 text-[12px]"
                 data-testid="lrc-save-error"
                 style={{ background: "rgba(255,100,100,0.12)", border: "1px solid rgba(255,100,100,0.3)", color: "#fca5a5" }}>
              <AlertTriangle className="inline h-4 w-4 mr-1" /> {saveError}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={onSave} disabled={saving} data-testid="lrc-save-btn"
                    className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
              {saving ? "Saving…" : (form.id ? "Save changes" : "Create campaign")}
            </button>
            <button onClick={onCancel} data-testid="lrc-cancel-btn"
                    className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/70 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
              Cancel
            </button>
            <div className="text-[10.5px] text-faded inline-flex items-center gap-1 ml-2">
              <Info className="h-3.5 w-3.5" /> New campaigns are saved <em>disabled</em>. Toggle on when ready.
            </div>
          </div>
        </div>

        {/* RIGHT — preview */}
        <div className="lg:sticky lg:top-2 space-y-2 min-w-0">
          <div className="text-[10.5px] uppercase tracking-wider text-gold font-bold flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" /> Live preview
          </div>
          {/* Issue 2 fix (Reward Experience Engine bug report) — this used to
              render the legacy, standalone `PopupPreview` mockup, which never
              consumed `form.experience` at all (no environment, decorations,
              glass, or particles). That made this thumbnail visually diverge
              from both the Designer Canvas below and the real student popup,
              which both render through `RewardExperienceShell`. Now there is
              exactly one presentation renderer for all three surfaces. */}
          <RewardExperiencePreview form={livePreview} device="iphone" />
          <div className="text-[10px] text-faded/70 text-center -mt-1">
            Same renderer as the Experience Designer canvas and the real student popup.
          </div>
          <div className="text-[10.5px] text-faded leading-relaxed">
            Students see this only when the campaign is enabled and the current time falls
            inside the start/end window. Reward amount is enforced by the backend on claim.
          </div>
        </div>
      </div>
    </div>
  );
}


/* ──────────────────────────────────────────────────────────────────────── */
/* Smart Push Notification fieldset (per-campaign, admin-only)              */
/* ──────────────────────────────────────────────────────────────────────── */

// One-click presets — confirmed copy from the project owner. Admin can
// still edit title/body before sending.
const PUSH_PRESETS_LRC = {
  en: {
    label: "English",
    title: "Login reward 🎁",
    body: "Your login reward is ready 🎁 Open EduHub now to claim it.",
  },
  km: {
    label: "ខ្មែរ",
    title: "រង្វាន់ Login 🎁",
    body: "អបអរសាទរ! អ្នកទទួលបាន Rewards🎁 សូមបើក EduHub ដើម្បីទទួលរង្វាន់ មុនពេលផុតកំណត់!",
  },
  bi: {
    label: "Bilingual",
    title: "Login reward 🎁 រង្វាន់ Login",
    body: "Your login reward is ready 🎁 សូមបើក EduHub ដើម្បីទទួលរង្វាន់ មុនពេលផុតកំណត់!",
  },
};

function PushNotificationFieldset({ form, set, campaignId }) {
  const [open, setOpen] = useState(!!form.push_enabled);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [sendError, setSendError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const applyPreset = useCallback((key) => {
    const p = PUSH_PRESETS_LRC[key];
    if (!p) return;
    set("push_title", p.title);
    set("push_body", p.body);
  }, [set]);

  const canSend = !!campaignId && !!form.push_enabled
    && (form.push_title || "").trim().length > 0
    && (form.push_body || "").trim().length > 0;

  // AUDIT FIX — Send the CURRENT editor values as overrides so what the admin
  // sees is exactly what gets sent. The backend still falls back to the saved
  // campaign push_* fields if any override is omitted, but here we always pass
  // the live form values. Sending NEVER credits a reward.
  const onConfirmSend = useCallback(async () => {
    setConfirmOpen(false);
    if (!campaignId) return;
    setSending(true);
    setSendError("");
    setSendResult(null);
    try {
      const r = await sendLoginRewardCampaignPushNow(campaignId, {
        title: (form.push_title || "").trim(),
        body: (form.push_body || "").trim(),
        target:
          form.push_target === "all_subscribers"
            ? "all_subscribers"
            : "eligible_unclaimed",
      });
      setSendResult(r || { sent: 0, failed: 0 });
    } catch (e) {
      setSendError((e && e.message) || "Send failed.");
    } finally {
      setSending(false);
    }
  }, [campaignId, form.push_title, form.push_body, form.push_target]);

  return (
    <fieldset className="space-y-2 rounded-xl border border-parchment/15 bg-walnut/30 p-3"
              data-testid="lrc-push-fieldset">
      <button type="button" onClick={() => setOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 text-left"
              data-testid="lrc-push-toggle">
        <span className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider text-gold">
          <Bell className="h-3.5 w-3.5" /> Smart Push Notification
        </span>
        <span className="text-faded">{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
      </button>
      {open && (
        <div className="space-y-2.5">
          <label className="inline-flex items-center gap-2 text-[12px] text-parchment">
            <input type="checkbox" checked={!!form.push_enabled}
                   onChange={(e) => set("push_enabled", e.target.checked)}
                   data-testid="lrc-push-enabled" />
            Enable push for this campaign
          </label>
          <p className="text-[10.5px] text-faded leading-relaxed">
            <Info className="inline h-3 w-3 mr-1" />
            Push only reaches students who allowed notifications. Sending is
            manual — click <strong>Send Push Now</strong> below. No automatic
            send on save.
          </p>

          {form.push_enabled && (
            <>
              <div className="flex flex-wrap gap-1.5" data-action-row>
                <span className="text-[10.5px] text-faded mr-1 self-center">Presets:</span>
                {Object.entries(PUSH_PRESETS_LRC).map(([k, p]) => (
                  <button key={k} type="button"
                          onClick={() => applyPreset(k)}
                          data-testid={`lrc-push-preset-${k}`}
                          className="inline-flex items-center rounded-full border border-parchment/20 bg-black/30 px-2.5 py-1 text-[10.5px] font-semibold text-parchment hover:border-gold hover:text-gold">
                    {p.label}
                  </button>
                ))}
              </div>

              <label className="block">
                <span className="text-[11px] text-faded">Notification title</span>
                <input type="text" value={form.push_title || ""}
                       onChange={(e) => set("push_title", e.target.value)}
                       maxLength={120}
                       placeholder="Login reward 🎁"
                       data-testid="lrc-push-title"
                       className="mt-1 w-full max-w-full box-border rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold" />
              </label>

              <label className="block">
                <span className="text-[11px] text-faded">Notification body (max 500 chars)</span>
                <textarea rows={3} value={form.push_body || ""}
                          onChange={(e) => set("push_body", e.target.value)}
                          maxLength={500}
                          placeholder="Your login reward is ready 🎁 Open EduHub now to claim it."
                          data-testid="lrc-push-body"
                          className="mt-1 w-full max-w-full box-border rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
                          style={{ wordBreak: "break-word", overflowWrap: "anywhere" }} />
              </label>

              <label className="block">
                <span className="text-[11px] text-faded">Target audience</span>
                <select value={form.push_target || "eligible_unclaimed"}
                        onChange={(e) => set("push_target", e.target.value)}
                        data-testid="lrc-push-target"
                        className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/15 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold">
                  <option value="eligible_unclaimed">Eligible students who haven’t claimed yet</option>
                  <option value="all_subscribers">All push subscribers</option>
                </select>
              </label>

              {/* Preview card */}
              <div className="rounded-xl border border-parchment/15 bg-black/30 p-3 max-w-full overflow-hidden"
                   data-testid="lrc-push-preview"
                   style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}>
                <div className="text-[10px] uppercase tracking-wider text-faded mb-1.5">Preview</div>
                <div className="flex items-start gap-2">
                  <div className="h-8 w-8 rounded-lg grid place-items-center shrink-0"
                       style={{ background: "linear-gradient(135deg, #FFE19A, #D4A843)" }}>
                    <Bell className="h-4 w-4 text-ink" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-parchment break-words">
                      {form.push_title || "(no title)"}
                    </div>
                    <div className="text-[12px] text-faded break-words">
                      {form.push_body || "(no body)"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1" data-action-row>
                <button type="button"
                        onClick={() => setConfirmOpen(true)}
                        disabled={!canSend || sending}
                        data-testid="lrc-push-send-now-btn"
                        className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-walnut/70 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-gold disabled:opacity-50">
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {sending ? "Sending…" : "Send Push Now"}
                </button>
                {!campaignId && (
                  <span className="text-[10.5px] text-faded">
                    Save the campaign first to enable sending.
                  </span>
                )}
                {sendResult && (
                  <span className="text-[11px] text-emerald-300" data-testid="lrc-push-send-result">
                    <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" />
                    Sent {sendResult.sent ?? 0} · Failed {sendResult.failed ?? 0}
                  </span>
                )}
                {sendError && (
                  <span className="text-[11px] text-red-300" data-testid="lrc-push-send-error">
                    <AlertTriangle className="inline h-3.5 w-3.5 mr-1" /> {sendError}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/60 p-4"
             role="dialog" aria-modal="true" data-testid="lrc-push-confirm">
          <div className="w-full max-w-sm rounded-2xl border border-parchment/20 bg-walnut p-5 space-y-3">
            <div className="text-[14px] font-semibold text-parchment">
              Send push notification?
            </div>
            <div className="text-[12px] text-faded leading-relaxed break-words">
              This will send <strong className="text-parchment">{form.push_title || "(no title)"}</strong>
              {" "}to{" "}
              <strong className="text-parchment">
                {form.push_target === "all_subscribers" ? "all push subscribers" : "eligible students who haven’t claimed"}
              </strong>.
              {" "}There is no undo. Make sure the copy is correct.
            </div>
            <div className="flex flex-wrap gap-2 justify-end" data-action-row>
              <button type="button" onClick={() => setConfirmOpen(false)}
                      className="rounded-full border border-parchment/20 bg-black/30 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold"
                      data-testid="lrc-push-confirm-cancel">
                Cancel
              </button>
              <button type="button" onClick={onConfirmSend}
                      className="rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
                      style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
                      data-testid="lrc-push-confirm-ok">
                Send now
              </button>
            </div>
          </div>
        </div>
      )}
    </fieldset>
  );
}
