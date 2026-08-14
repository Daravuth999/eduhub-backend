/**
 * LoginMysteryStudio.jsx — Author Studio panel for Login Mystery Box Rewards.
 *
 * Reuses the same Studio admin auth + API client as every other panel
 * (require_admin on the backend). Lets staff:
 *   • create / enable / disable / delete login-mystery campaigns
 *   • configure 4-box reward pool with weights, types, labels, rarities
 *   • see analytics: total claims, points/voucher/EduTalk passes issued,
 *     most-selected box position, reward distribution, recent claims
 *
 * Does NOT touch existing Studio panels — added next to MysteryBoxStudio.
 */
import { useEffect, useMemo, useState } from "react";
import { Boxes, PlusCircle, Save, Trash2, BarChart3, Power, Loader2, Sparkles } from "lucide-react";
import {
  listLoginMysteryCampaigns,
  createLoginMysteryCampaign,
  updateLoginMysteryCampaign,
  deleteLoginMysteryCampaign,
  listLoginMysteryClaims,
  getLoginMysteryAnalytics,
} from "./api";

const REWARD_TYPES = [
  { value: "points",             label: "Points" },
  { value: "voucher",            label: "Book Voucher" },
  { value: "edutalk_session",    label: "EduTalk Session Pass" },
  { value: "edutalk_voice",      label: "EduTalk Voice Pass" },
  { value: "edutalk_live_coupon", label: "Live Voice Coach Coupon" },
];

const RARITIES = ["common", "rare", "epic", "legendary"];
const FREQUENCIES = [
  { value: "once_per_day",      label: "Once per day" },
  { value: "once_per_campaign", label: "Once per campaign" },
];
const AUDIENCES = [
  { value: "all",                label: "All students" },
  { value: "specific_students",  label: "Specific students (include list)" },
  { value: "exclude_only",       label: "Everyone except excluded" },
];

function defaultRewardItem(seed = {}) {
  return {
    label: seed.label || "Reward",
    description: seed.description || "",
    rarity: seed.rarity || "common",
    accent_color: seed.accent_color || "#D4A843",
    icon: seed.icon || "gift",
    enabled: true,
    weight: seed.weight ?? 10,
    reward_type: seed.reward_type || "points",
    points: seed.points ?? 0,
    voucher_discount_type: seed.voucher_discount_type || "percent",
    voucher_discount_value: seed.voucher_discount_value ?? 0,
    voucher_max_uses: seed.voucher_max_uses ?? 1,
    voucher_valid_days: seed.voucher_valid_days ?? 30,
    voucher_book_slugs: seed.voucher_book_slugs || [],
    voucher_title: seed.voucher_title || "Book Voucher",
    voucher_subtitle: seed.voucher_subtitle || "",
    voucher_template: seed.voucher_template || "royal_purple_gold",
    voucher_accent_color: seed.voucher_accent_color || "#D4A843",
    edutalk_quantity: seed.edutalk_quantity ?? 1,
    edutalk_expires_in_days: seed.edutalk_expires_in_days ?? 30,
    edutalk_eligible_book_slugs: seed.edutalk_eligible_book_slugs || [],
    edutalk_title: seed.edutalk_title || "EduTalk Pass",
    edutalk_live_coupon_amount: seed.edutalk_live_coupon_amount ?? 20,
    edutalk_live_coupon_expires_in_days: seed.edutalk_live_coupon_expires_in_days ?? 30,
    edutalk_live_coupon_title: seed.edutalk_live_coupon_title || "Live Voice Coach Coupon",
  };
}

function defaultCampaign() {
  return {
    id: null,
    name: "Login Mystery Box",
    description: "",
    enabled: false,
    priority: 0,
    start_at: "",
    end_at: "",
    timezone: "Asia/Phnom_Penh",
    claim_frequency: "once_per_day",
    audience_type: "all",
    include_student_ids: [],
    exclude_student_ids: [],
    title: "Mystery Reward",
    subtitle: "Pick a box to reveal your reward!",
    cta_text: "Open Box",
    success_message: "Reward claimed! Great pick!",
    post_claim_message: "See what was inside the other boxes...",
    accent_color: "#D4A843",
    reveal_remaining: true,
    animation_theme: "royal_gold",
    reward_pool: [
      defaultRewardItem({ label: "Small Points", weight: 50, reward_type: "points", points: 10, rarity: "common" }),
      defaultRewardItem({ label: "Medium Points", weight: 30, reward_type: "points", points: 25, rarity: "common" }),
      defaultRewardItem({ label: "Book Voucher", weight: 15, reward_type: "voucher", rarity: "rare",
                          voucher_discount_type: "percent", voucher_discount_value: 30 }),
      defaultRewardItem({ label: "EduTalk Pass", weight: 5, reward_type: "edutalk_session", rarity: "legendary",
                          edutalk_quantity: 1, edutalk_expires_in_days: 30 }),
    ],
  };
}

function csvParse(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/* ──────────────────────────────────────────────────────────────────── */
/* Root component                                                        */
/* ──────────────────────────────────────────────────────────────────── */
export default function LoginMysteryStudio() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(defaultCampaign());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [analytics, setAnalytics] = useState(null);
  const [claims, setClaims] = useState([]);
  const [tab, setTab] = useState("editor"); // editor | analytics

  const refreshList = async () => {
    setLoading(true);
    try {
      const r = await listLoginMysteryCampaigns();
      setCampaigns(r.campaigns || []);
    } catch (e) {
      setToast(`Load failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refreshList(); }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      try {
        const [a, c] = await Promise.all([
          getLoginMysteryAnalytics(selectedId),
          listLoginMysteryClaims({ campaign_id: selectedId, limit: 100 }),
        ]);
        if (cancelled) return;
        setAnalytics(a);
        setClaims(c.claims || []);
      } catch (e) {
        if (!cancelled) setToast(`Analytics load failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) return;
    setAnalytics(null);
    setClaims([]);
  }, [selectedId]);

  const onSelect = (camp) => {
    setSelectedId(camp.id);
    setDraft({
      ...defaultCampaign(),
      ...camp,
      include_student_ids: camp.include_student_ids || [],
      exclude_student_ids: camp.exclude_student_ids || [],
      reward_pool: (camp.reward_pool || []).map(defaultRewardItem),
    });
    setTab("editor");
  };

  const onNew = () => {
    setSelectedId(null);
    setDraft(defaultCampaign());
    setTab("editor");
  };

  const onSave = async () => {
    setSaving(true);
    setToast("");
    try {
      const payload = {
        ...draft,
        include_student_ids: csvParse(draft.include_student_ids),
        exclude_student_ids: csvParse(draft.exclude_student_ids),
        // strip null/empty datetime strings (backend tolerates)
        start_at: draft.start_at || null,
        end_at: draft.end_at || null,
      };
      let saved;
      if (selectedId) {
        const r = await updateLoginMysteryCampaign(selectedId, payload);
        saved = r.campaign;
      } else {
        const r = await createLoginMysteryCampaign(payload);
        saved = r.campaign;
        setSelectedId(saved.id);
      }
      setToast(`Saved · ${saved.name}`);
      await refreshList();
    } catch (e) {
      setToast(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!selectedId) return;
    if (!window.confirm("Delete this Login Mystery Box campaign? This cannot be undone.")) return;
    setSaving(true);
    try {
      await deleteLoginMysteryCampaign(selectedId);
      setToast("Campaign deleted.");
      setSelectedId(null);
      setDraft(defaultCampaign());
      await refreshList();
    } catch (e) {
      setToast(`Delete failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnable = async () => {
    if (!selectedId) {
      setDraft((d) => ({ ...d, enabled: !d.enabled }));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...draft,
        enabled: !draft.enabled,
        include_student_ids: csvParse(draft.include_student_ids),
        exclude_student_ids: csvParse(draft.exclude_student_ids),
        start_at: draft.start_at || null,
        end_at: draft.end_at || null,
      };
      const r = await updateLoginMysteryCampaign(selectedId, payload);
      setDraft({ ...defaultCampaign(), ...r.campaign });
      await refreshList();
      setToast(r.campaign.enabled ? "Campaign enabled." : "Campaign disabled.");
    } catch (e) {
      setToast(`Toggle failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-parchment" data-testid="login-mystery-studio">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Boxes className="h-5 w-5 text-gold" />
        <h2 className="font-display text-xl">Login Mystery Box Rewards</h2>
        <span className="text-[11px] text-faded">Backend-authoritative · 4 boxes · weighted random</span>
        <div className="flex-1" />
        <button onClick={onNew} data-testid="lms-new-btn"
                className="inline-flex items-center gap-1.5 rounded-full bg-gold/15 border border-gold/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider hover:bg-gold/25">
          <PlusCircle className="h-3.5 w-3.5" /> New campaign
        </button>
      </div>

      <div className="grid md:grid-cols-[260px_1fr] gap-4">
        {/* Sidebar list */}
        <aside className="rounded-2xl border border-gold/15 p-3"
               style={{ background: "rgba(20,14,32,0.65)" }}>
          <div className="text-[10px] uppercase tracking-[0.25em] text-faded mb-2">Campaigns</div>
          {loading && <p className="text-[12px] text-faded">Loading…</p>}
          {!loading && campaigns.length === 0 && (
            <p className="text-[12px] text-faded">No campaigns yet. Create one →</p>
          )}
          <ul className="space-y-1.5" data-testid="lms-campaign-list">
            {campaigns.map((c) => {
              const active = selectedId === c.id;
              return (
                <li key={c.id}>
                  <button onClick={() => onSelect(c)}
                          data-testid={`lms-campaign-item-${c.id}`}
                          className="w-full text-left rounded-lg px-3 py-2 transition-all"
                          style={{
                            background: active ? "rgba(212,168,67,0.18)" : "rgba(45,31,62,0.45)",
                            border: active ? "1px solid rgba(255,225,154,0.55)" : "1px solid rgba(212,168,67,0.18)",
                          }}>
                    <div className="text-[12.5px] font-bold truncate">{c.name}</div>
                    <div className="text-[10.5px] text-faded flex items-center gap-2">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.enabled ? "bg-emerald-400" : "bg-rose-400"}`} />
                      {c.status || (c.enabled ? "live" : "disabled")}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Main panel */}
        <section className="rounded-2xl border border-gold/15 p-4"
                 style={{ background: "rgba(20,14,32,0.55)" }}>
          <div className="flex gap-1.5 mb-4">
            <button onClick={() => setTab("editor")}
                    data-testid="lms-tab-editor"
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${tab === "editor" ? "bg-gold/25 border border-gold/55" : "bg-walnut/60 border border-gold/20"}`}>
              <Sparkles className="h-3 w-3" /> Editor
            </button>
            <button onClick={() => setTab("analytics")}
                    data-testid="lms-tab-analytics"
                    disabled={!selectedId}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${tab === "analytics" ? "bg-gold/25 border border-gold/55" : "bg-walnut/60 border border-gold/20"} ${!selectedId ? "opacity-50 cursor-not-allowed" : ""}`}>
              <BarChart3 className="h-3 w-3" /> Analytics
            </button>
          </div>

          {tab === "editor" && (
            <EditorPanel draft={draft} setDraft={setDraft} />
          )}

          {tab === "analytics" && selectedId && (
            <AnalyticsPanel analytics={analytics} claims={claims} />
          )}

          {/* Action bar */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gold/15 pt-4">
            <button onClick={onSave} disabled={saving}
                    data-testid="lms-save-btn"
                    className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
                    style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {selectedId ? "Save changes" : "Create campaign"}
            </button>
            <button onClick={toggleEnable} disabled={saving}
                    data-testid="lms-toggle-btn"
                    className="inline-flex items-center gap-1.5 rounded-full border border-gold/35 bg-walnut/60 px-3 py-2 text-[11px] font-bold uppercase tracking-wider hover:border-gold">
              <Power className="h-3.5 w-3.5" /> {draft.enabled ? "Disable" : "Enable"}
            </button>
            {selectedId && (
              <button onClick={onDelete} disabled={saving}
                      data-testid="lms-delete-btn"
                      className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-900/30 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-rose-200 hover:bg-rose-900/50">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
            <div className="flex-1" />
            {toast && (
              <span className="text-[11px] text-faded" data-testid="lms-toast">{toast}</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Editor sub-panel                                                      */
/* ──────────────────────────────────────────────────────────────────── */
function EditorPanel({ draft, setDraft }) {
  const totalWeight = useMemo(
    () => (draft.reward_pool || []).filter((r) => r.enabled).reduce((s, r) => s + (Number(r.weight) || 0), 0),
    [draft.reward_pool],
  );

  const updateField = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const updateReward = (idx, k, v) =>
    setDraft((d) => ({
      ...d,
      reward_pool: d.reward_pool.map((r, i) => (i === idx ? { ...r, [k]: v } : r)),
    }));
  const addReward = () =>
    setDraft((d) => ({ ...d, reward_pool: [...(d.reward_pool || []), defaultRewardItem({ label: "New reward" })] }));
  const removeReward = (idx) =>
    setDraft((d) => ({ ...d, reward_pool: d.reward_pool.filter((_, i) => i !== idx) }));

  return (
    <div className="space-y-5">
      {/* Basics */}
      <Section title="Campaign basics">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Name" required>
            <input type="text" value={draft.name}
                   onChange={(e) => updateField("name", e.target.value)}
                   data-testid="lms-field-name"
                   className="lms-input" />
          </Field>
          <Field label="Priority (higher first)">
            <input type="number" value={draft.priority}
                   onChange={(e) => updateField("priority", Number(e.target.value))}
                   className="lms-input" />
          </Field>
          <Field label="Description / admin notes" full>
            <textarea value={draft.description}
                      onChange={(e) => updateField("description", e.target.value)}
                      rows={2}
                      className="lms-input" />
          </Field>
        </div>
      </Section>

      {/* Schedule + frequency */}
      <Section title="Schedule & frequency">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Start at (ISO datetime, optional)">
            <input type="datetime-local" value={toLocal(draft.start_at)}
                   onChange={(e) => updateField("start_at", toIso(e.target.value))}
                   data-testid="lms-field-start"
                   className="lms-input" />
          </Field>
          <Field label="End at (ISO datetime, optional)">
            <input type="datetime-local" value={toLocal(draft.end_at)}
                   onChange={(e) => updateField("end_at", toIso(e.target.value))}
                   data-testid="lms-field-end"
                   className="lms-input" />
          </Field>
          <Field label="Claim frequency">
            <select value={draft.claim_frequency}
                    onChange={(e) => updateField("claim_frequency", e.target.value)}
                    data-testid="lms-field-frequency"
                    className="lms-input">
              {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Timezone (display only)">
            <input type="text" value={draft.timezone || ""}
                   onChange={(e) => updateField("timezone", e.target.value)}
                   className="lms-input" />
          </Field>
        </div>
      </Section>

      {/* Audience */}
      <Section title="Audience / eligibility">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Audience type">
            <select value={draft.audience_type}
                    onChange={(e) => updateField("audience_type", e.target.value)}
                    data-testid="lms-field-audience"
                    className="lms-input">
              {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </Field>
          <Field label="Include student IDs (comma/space separated)" full>
            <textarea rows={2}
                      value={Array.isArray(draft.include_student_ids) ? draft.include_student_ids.join(", ") : draft.include_student_ids}
                      onChange={(e) => updateField("include_student_ids", e.target.value)}
                      placeholder="stu001, stu002"
                      className="lms-input" />
          </Field>
          <Field label="Exclude student IDs (comma/space separated)" full>
            <textarea rows={2}
                      value={Array.isArray(draft.exclude_student_ids) ? draft.exclude_student_ids.join(", ") : draft.exclude_student_ids}
                      onChange={(e) => updateField("exclude_student_ids", e.target.value)}
                      className="lms-input" />
          </Field>
        </div>
      </Section>

      {/* Messaging */}
      <Section title="Messaging & UI">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Modal title">
            <input type="text" value={draft.title}
                   onChange={(e) => updateField("title", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="CTA text (per box)">
            <input type="text" value={draft.cta_text}
                   onChange={(e) => updateField("cta_text", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="Subtitle" full>
            <input type="text" value={draft.subtitle}
                   onChange={(e) => updateField("subtitle", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="Success message" full>
            <input type="text" value={draft.success_message}
                   onChange={(e) => updateField("success_message", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="Post-claim message" full>
            <input type="text" value={draft.post_claim_message}
                   onChange={(e) => updateField("post_claim_message", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="Accent color (hex)">
            <input type="text" value={draft.accent_color}
                   onChange={(e) => updateField("accent_color", e.target.value)}
                   className="lms-input" />
          </Field>
          <Field label="Reveal remaining boxes after claim">
            <label className="inline-flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!draft.reveal_remaining}
                     onChange={(e) => updateField("reveal_remaining", e.target.checked)}
                     data-testid="lms-field-reveal-remaining" />
              Show what was inside the other 3 boxes
            </label>
          </Field>
          <Field label="Animation theme">
            <select value={draft.animation_theme}
                    onChange={(e) => updateField("animation_theme", e.target.value)}
                    className="lms-input">
              <option value="royal_gold">Royal Gold</option>
              <option value="treasure_chest">Treasure Chest</option>
              <option value="neon_burst">Neon Burst</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* Reward pool */}
      <Section title="Reward pool"
               subtitle="4 boxes will be picked from this pool using weighted random. Higher weight = more likely.">
        <div className="text-[11px] text-faded mb-2">
          Total active weight: <strong className="text-gold">{totalWeight}</strong>
        </div>
        <ul className="space-y-3" data-testid="lms-reward-pool">
          {(draft.reward_pool || []).map((r, idx) => (
            <li key={idx}
                className="rounded-xl border border-gold/15 p-3"
                style={{ background: "rgba(45,31,62,0.5)" }}
                data-testid={`lms-reward-${idx}`}>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <label className="inline-flex items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={!!r.enabled}
                         onChange={(e) => updateReward(idx, "enabled", e.target.checked)} />
                  Active
                </label>
                <span className="text-[10px] uppercase tracking-[0.18em] text-faded">#{idx + 1}</span>
                <div className="flex-1" />
                <button onClick={() => removeReward(idx)}
                        className="inline-flex items-center gap-1 text-[11px] text-rose-300 hover:text-rose-100">
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Reward label (shown to student)">
                  <input type="text" value={r.label}
                         onChange={(e) => updateReward(idx, "label", e.target.value)}
                         className="lms-input" />
                </Field>
                <Field label="Weight (positive integer)">
                  <input type="number" min="1" value={r.weight}
                         onChange={(e) => updateReward(idx, "weight", Number(e.target.value))}
                         className="lms-input" />
                </Field>
                <Field label="Rarity">
                  <select value={r.rarity}
                          onChange={(e) => updateReward(idx, "rarity", e.target.value)}
                          className="lms-input">
                    {RARITIES.map((r2) => <option key={r2} value={r2}>{r2}</option>)}
                  </select>
                </Field>
                <Field label="Accent color (hex)">
                  <input type="text" value={r.accent_color}
                         onChange={(e) => updateReward(idx, "accent_color", e.target.value)}
                         className="lms-input" />
                </Field>
                <Field label="Reward type">
                  <select value={r.reward_type}
                          onChange={(e) => updateReward(idx, "reward_type", e.target.value)}
                          data-testid={`lms-reward-type-${idx}`}
                          className="lms-input">
                    {REWARD_TYPES.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
                  </select>
                </Field>
                <Field label="Short description (optional)">
                  <input type="text" value={r.description}
                         onChange={(e) => updateReward(idx, "description", e.target.value)}
                         className="lms-input" />
                </Field>

                {r.reward_type === "points" && (
                  <Field label="Points amount" required>
                    <input type="number" min="1" value={r.points}
                           onChange={(e) => updateReward(idx, "points", Number(e.target.value))}
                           data-testid={`lms-reward-points-${idx}`}
                           className="lms-input" />
                  </Field>
                )}
                {r.reward_type === "voucher" && (
                  <>
                    <Field label="Voucher type">
                      <select value={r.voucher_discount_type}
                              onChange={(e) => updateReward(idx, "voucher_discount_type", e.target.value)}
                              className="lms-input">
                        <option value="percent">Percent off</option>
                        <option value="fixed">Fixed amount off</option>
                      </select>
                    </Field>
                    <Field label="Discount value" required>
                      <input type="number" min="0.01" step="0.01" value={r.voucher_discount_value}
                             onChange={(e) => updateReward(idx, "voucher_discount_value", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Max uses (per coupon)">
                      <input type="number" min="1" value={r.voucher_max_uses || 1}
                             onChange={(e) => updateReward(idx, "voucher_max_uses", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Valid days from claim">
                      <input type="number" min="1" value={r.voucher_valid_days || 30}
                             onChange={(e) => updateReward(idx, "voucher_valid_days", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Eligible book slugs (CSV, blank = all)" full>
                      <input type="text"
                             value={Array.isArray(r.voucher_book_slugs) ? r.voucher_book_slugs.join(", ") : ""}
                             onChange={(e) => updateReward(idx, "voucher_book_slugs", csvParse(e.target.value))}
                             className="lms-input" />
                    </Field>
                  </>
                )}
                {(r.reward_type === "edutalk_session" || r.reward_type === "edutalk_voice") && (
                  <>
                    <Field label="Pass quantity" required>
                      <input type="number" min="1" value={r.edutalk_quantity}
                             onChange={(e) => updateReward(idx, "edutalk_quantity", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Expires in days">
                      <input type="number" min="1" value={r.edutalk_expires_in_days}
                             onChange={(e) => updateReward(idx, "edutalk_expires_in_days", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Eligible book slugs (CSV, blank = all)" full>
                      <input type="text"
                             value={Array.isArray(r.edutalk_eligible_book_slugs) ? r.edutalk_eligible_book_slugs.join(", ") : ""}
                             onChange={(e) => updateReward(idx, "edutalk_eligible_book_slugs", csvParse(e.target.value))}
                             className="lms-input" />
                    </Field>
                  </>
                )}
                {r.reward_type === "edutalk_live_coupon" && (
                  <>
                    <Field label="EduTalk points amount" required>
                      <input type="number" min="1" max="1000" value={r.edutalk_live_coupon_amount}
                             onChange={(e) => updateReward(idx, "edutalk_live_coupon_amount", Number(e.target.value))}
                             data-testid={`lms-reward-edutalk-live-coupon-amount-${idx}`}
                             className="lms-input" />
                    </Field>
                    <Field label="Expires in days">
                      <input type="number" min="1" value={r.edutalk_live_coupon_expires_in_days || 30}
                             onChange={(e) => updateReward(idx, "edutalk_live_coupon_expires_in_days", Number(e.target.value))}
                             className="lms-input" />
                    </Field>
                    <Field label="Coupon title" full>
                      <input type="text" value={r.edutalk_live_coupon_title}
                             onChange={(e) => updateReward(idx, "edutalk_live_coupon_title", e.target.value)}
                             className="lms-input" />
                    </Field>
                    <p className="sm:col-span-2 text-[11px] text-faded">
                      A student who wins this box unlocks a one-time code redeemable for{" "}
                      {r.edutalk_live_coupon_amount || 0} EduTalk points inside Live Voice Coach.
                    </p>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        <button onClick={addReward}
                data-testid="lms-add-reward-btn"
                className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-gold/35 bg-walnut/60 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider hover:border-gold">
          <PlusCircle className="h-3.5 w-3.5" /> Add reward
        </button>
      </Section>

      <style>{`
        .lms-input { width: 100%; background: rgba(20,14,32,0.85);
          border: 1px solid rgba(212,168,67,0.28); color: #F4E5C1;
          border-radius: 10px; padding: 8px 10px; font-size: 13px;
          outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
        .lms-input:focus { border-color: rgba(255,225,154,0.7);
          box-shadow: 0 0 0 2px rgba(255,225,154,0.18); }
      `}</style>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div>
      <div className="mb-2">
        <h3 className="text-[11px] uppercase tracking-[0.22em] text-gold/90 font-bold">{title}</h3>
        {subtitle && <p className="text-[11px] text-faded">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, required, full = false, children }) {
  return (
    <label className={full ? "sm:col-span-2" : ""}>
      <span className="block text-[10.5px] uppercase tracking-[0.18em] text-faded mb-1">
        {label}{required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

function toLocal(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    // datetime-local needs YYYY-MM-DDTHH:mm in *local* time.
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}
function toIso(local) {
  if (!local) return "";
  try {
    const d = new Date(local);
    if (isNaN(d.getTime())) return "";
    return d.toISOString();
  } catch { return ""; }
}

/* ──────────────────────────────────────────────────────────────────── */
/* Analytics sub-panel                                                   */
/* ──────────────────────────────────────────────────────────────────── */
function AnalyticsPanel({ analytics, claims }) {
  if (!analytics) {
    return (
      <div className="text-[12px] text-faded flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading analytics…
      </div>
    );
  }
  const t = analytics.totals || {};
  return (
    <div className="space-y-5" data-testid="lms-analytics">
      <div className="grid sm:grid-cols-4 gap-3">
        <StatCard label="Total claims" value={t.total_claims || 0} />
        <StatCard label="Points issued" value={t.points_issued || 0} />
        <StatCard label="Vouchers issued" value={t.vouchers_issued || 0} />
        <StatCard label="EduTalk passes"
                  value={(t.edutalk_sessions_issued || 0) + (t.edutalk_voice_issued || 0)} />
      </div>

      <Section title="Most-selected box position">
        <ul className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => {
            const row = (analytics.box_distribution || []).find((b) => b.box_index === i);
            const count = row ? row.count : 0;
            const max = Math.max(1, ...(analytics.box_distribution || []).map((b) => b.count || 0));
            const pct = Math.round((count / max) * 100);
            return (
              <li key={i} className="rounded-xl border border-gold/15 p-3"
                  style={{ background: "rgba(45,31,62,0.55)" }}>
                <div className="text-[10.5px] uppercase tracking-[0.18em] text-faded">Box {i + 1}</div>
                <div className="text-xl font-bold text-gold">{count}</div>
                <div className="h-1.5 rounded-full bg-walnut/60 mt-1 overflow-hidden">
                  <div className="h-full rounded-full"
                       style={{ width: `${pct}%`, background: "linear-gradient(90deg,#FFE19A,#D4A843)" }} />
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Reward distribution">
        <ul className="space-y-1.5">
          {(analytics.reward_distribution || []).map((r, i) => (
            <li key={i} className="text-[12px] flex items-center gap-2">
              <span className="inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] border border-gold/25 text-gold/90">
                {r.reward_type}
              </span>
              <span className="truncate">{r.label}</span>
              <div className="flex-1" />
              <span className="text-gold font-bold">{r.count}</span>
            </li>
          ))}
          {(!analytics.reward_distribution || analytics.reward_distribution.length === 0) && (
            <li className="text-[11px] text-faded">No claims yet.</li>
          )}
        </ul>
      </Section>

      <Section title={`Recent claims (${claims.length})`}>
        <ul className="space-y-1.5 max-h-[320px] overflow-y-auto">
          {claims.map((c, i) => (
            <li key={c.id || i}
                className="rounded-lg border border-gold/15 p-2 text-[11.5px]"
                style={{ background: "rgba(45,31,62,0.45)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-parchment">{c.student_id}</strong>
                <span className="text-faded">picked Box {(c.selected_box_index ?? 0) + 1}</span>
                <span className="text-gold">·</span>
                <span>{(c.selected || {}).label}</span>
                <span className="text-faded">({(c.selected || {}).reward_type})</span>
                <div className="flex-1" />
                <span className="text-faded text-[10.5px]">
                  {(c.credited_at || c.claimed_at || "").slice(0, 19).replace("T", " ")}
                </span>
              </div>
            </li>
          ))}
          {claims.length === 0 && <li className="text-[11px] text-faded">No claims yet.</li>}
        </ul>
      </Section>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-2xl border border-gold/20 p-3"
         style={{ background: "rgba(45,31,62,0.6)" }}>
      <div className="text-[10.5px] uppercase tracking-[0.2em] text-faded">{label}</div>
      <div className="text-2xl font-bold text-gold">{value}</div>
    </div>
  );
}
