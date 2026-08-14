/**
 * ArtworkCampaignStudio.jsx — Author Studio › Artwork Campaigns (v1.0)
 *
 * Lets administrators upload-by-link one high-quality artwork, choose where
 * it appears (Dashboard Hero / Library Hero / Featured Collection / Shelf
 * Card / multiple), what it does on click, when it runs, its priority and
 * whether it's active. v1.0 is link-based — no cropping, no server image
 * processing. A live preview shows exactly how each placement will render.
 *
 * Fully additive: uses the existing studio auth/session + the new
 * /api/artwork-campaigns endpoints. Touches no other studio module.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image as ImageIcon, Plus, RefreshCw, Trash2, Pencil, X,
  ToggleLeft, ToggleRight, Eye, Star, Save, AlertTriangle, Check,
} from "lucide-react";
import {
  listArtworkCampaigns, createArtworkCampaign,
  updateArtworkCampaign, deleteArtworkCampaign,
} from "./api";
import {
  PLACEMENTS, CLICK_ACTIONS, ANIMATIONS,
} from "../eduhub/components/artwork/artworkConfig";
import ArtworkImage from "../eduhub/components/artwork/ArtworkImage";

const BLANK = {
  name: "",
  image_url: "",
  fallback_url: "",
  image_focus: "center",
  placements: [],
  click_action: { type: "topup", value: "" },
  animation: "fade",
  start_date: "",
  end_date: "",
  priority: 5,
  active: true,
};

const FOCUS_OPTIONS = [
  { v: "center", l: "Center" },
  { v: "top", l: "Top" },
  { v: "bottom", l: "Bottom" },
  { v: "left", l: "Left" },
  { v: "right", l: "Right" },
];

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function toInputDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return ""; }
}

const fieldStyle = {
  width: "100%",
  background: "rgba(20,14,32,0.7)",
  border: "1px solid rgba(212,168,67,0.25)",
  borderRadius: 12,
  color: "#F4E5C1",
  padding: "10px 12px",
  fontSize: 13,
  outline: "none",
};

const labelCls = "block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5";

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <p className={labelCls}>{title}</p>
      {children}
    </div>
  );
}

function CampaignForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial || BLANK);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAction = (k, v) => setForm((f) => ({ ...f, click_action: { ...f.click_action, [k]: v } }));

  const togglePlacement = (key) =>
    setForm((f) => ({
      ...f,
      placements: f.placements.includes(key)
        ? f.placements.filter((p) => p !== key)
        : [...f.placements, key],
    }));

  const activeAction = CLICK_ACTIONS.find((a) => a.key === form.click_action.type) || CLICK_ACTIONS[0];

  const previewPlacement = form.placements[0] || "dashboard_hero";
  const previewCampaign = useMemo(
    () => ({
      ...form,
      id: "preview",
      image_focus: form.image_focus || "center",
      fallback_url: form.fallback_url || null,
    }),
    [form]
  );

  const handleSubmit = async () => {
    setErr(null);
    if (!form.name.trim()) return setErr("Campaign name is required.");
    if (!form.image_url.trim()) return setErr("Artwork image URL is required.");
    if (!form.placements.length) return setErr("Pick at least one placement.");
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        image_url: form.image_url.trim(),
        fallback_url: form.fallback_url.trim() || null,
        image_focus: form.image_focus || "center",
        placements: form.placements,
        click_action: {
          type: form.click_action.type,
          value: (form.click_action.value || "").trim(),
        },
        animation: form.animation,
        start_date: form.start_date ? new Date(form.start_date).toISOString() : null,
        end_date: form.end_date ? new Date(form.end_date).toISOString() : null,
        priority: Number(form.priority) || 5,
        active: !!form.active,
      };
      if (initial && initial.id) await updateArtworkCampaign(initial.id, payload);
      else await createArtworkCampaign(payload);
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="rounded-2xl border border-gold/25 p-5 mb-6"
      style={{ background: "rgba(20,14,32,0.55)" }}
      data-testid="artwork-form"
    >
      <div className="flex items-center gap-2 mb-4">
        <ImageIcon className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px] text-parchment">
          {initial && initial.id ? "Edit campaign" : "New artwork campaign"}
        </h3>
        <div className="flex-1" />
        {onCancel && (
          <button onClick={onCancel} data-testid="artwork-form-cancel"
                  className="text-faded hover:text-parchment">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <Section title="Campaign name">
            <input style={fieldStyle} value={form.name} data-testid="artwork-name"
                   onChange={(e) => set("name", e.target.value)} placeholder="e.g. Top Up & Get More" />
          </Section>

          <Section title="Artwork image URL (one high-quality link)">
            <input style={fieldStyle} value={form.image_url} data-testid="artwork-image-url"
                   onChange={(e) => set("image_url", e.target.value)} placeholder="https://…/artwork.png" />
          </Section>

          <Section title="Fallback image URL (optional)">
            <input style={fieldStyle} value={form.fallback_url} data-testid="artwork-fallback-url"
                   onChange={(e) => set("fallback_url", e.target.value)} placeholder="https://…/fallback.png" />
          </Section>

          <Section title="Crop focus">
            <select style={fieldStyle} value={form.image_focus} data-testid="artwork-focus"
                    onChange={(e) => set("image_focus", e.target.value)}>
              {FOCUS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </Section>

          <Section title="Placement (one or more)">
            <div className="flex flex-wrap gap-2" data-testid="artwork-placements">
              {PLACEMENTS.map((p) => {
                const on = form.placements.includes(p.key);
                return (
                  <button key={p.key} type="button" onClick={() => togglePlacement(p.key)}
                          data-testid={`artwork-placement-${p.key}`}
                          className="rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
                          style={{
                            background: on ? "linear-gradient(135deg,#FFE19A,#D4A843)" : "rgba(45,31,62,0.65)",
                            color: on ? "#1a1420" : "#F4E5C1",
                            border: on ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
                          }}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>

        <div>
          <Section title="Click action">
            <select style={fieldStyle} value={form.click_action.type} data-testid="artwork-action-type"
                    onChange={(e) => setAction("type", e.target.value)}>
              {CLICK_ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
            {activeAction.needsValue && (
              <input style={{ ...fieldStyle, marginTop: 8 }} value={form.click_action.value}
                     data-testid="artwork-action-value"
                     onChange={(e) => setAction("value", e.target.value)}
                     placeholder={activeAction.hint || "value"} />
            )}
          </Section>

          <Section title="Animation">
            <select style={fieldStyle} value={form.animation} data-testid="artwork-animation"
                    onChange={(e) => set("animation", e.target.value)}>
              {ANIMATIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </Section>

          <div className="grid grid-cols-2 gap-3">
            <Section title="Start date">
              <input type="date" style={fieldStyle} value={toInputDate(form.start_date)} data-testid="artwork-start-date"
                     onChange={(e) => set("start_date", e.target.value)} />
            </Section>
            <Section title="End date">
              <input type="date" style={fieldStyle} value={toInputDate(form.end_date)} data-testid="artwork-end-date"
                     onChange={(e) => set("end_date", e.target.value)} />
            </Section>
          </div>

          <Section title={`Priority (1–10) · ${form.priority}`}>
            <input type="range" min="1" max="10" value={form.priority} data-testid="artwork-priority"
                   onChange={(e) => set("priority", Number(e.target.value))} className="w-full accent-[#D4A843]" />
          </Section>

          <button type="button" onClick={() => set("active", !form.active)} data-testid="artwork-active-toggle"
                  className="inline-flex items-center gap-2 text-[12px] font-bold text-parchment">
            {form.active
              ? <ToggleRight className="h-6 w-6 text-green-400" />
              : <ToggleLeft className="h-6 w-6 text-faded" />}
            {form.active ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      {/* Live preview */}
      {form.image_url && (
        <div className="mt-5">
          <p className={labelCls}><Eye className="inline h-3 w-3 mr-1" /> Live preview · {previewPlacement}</p>
          <div style={{ maxWidth: previewPlacement === "library_shelf" ? 160 : 520 }}>
            <ArtworkImage campaign={previewCampaign} placement={previewPlacement}
                          scrim={previewPlacement !== "library_shelf"}
                          caption={previewPlacement !== "library_shelf" ? form.name : null}
                          testid="artwork-preview" />
          </div>
        </div>
      )}

      {err && (
        <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="artwork-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button onClick={handleSubmit} disabled={saving} data-testid="artwork-save"
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save campaign"}
        </button>
        {onCancel && (
          <button onClick={onCancel}
                  className="rounded-full border border-parchment/25 px-4 py-2.5 text-[12px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function CampaignRow({ c, onEdit, onToggle, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="rounded-xl border border-white/8 p-3 flex items-center gap-3"
         style={{ background: "rgba(30,22,44,0.5)" }} data-testid={`artwork-row-${c.id}`}>
      <div className="h-14 w-24 flex-none overflow-hidden rounded-lg bg-black/30">
        <img src={c.image_url} alt={c.name} className="h-full w-full object-cover"
             style={{ objectPosition: c.image_focus || "center" }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-display text-[14px] text-parchment">{c.name}</p>
          {c.active
            ? <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(52,211,153,0.15)", color: "#6ee7b7" }}>Live</span>
            : <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af" }}>Off</span>}
        </div>
        <p className="truncate text-[11px] text-faded">
          {c.placements.map((p) => (PLACEMENTS.find((x) => x.key === p) || {}).label || p).join(" · ")}
        </p>
        <p className="text-[10.5px] text-faded">
          <Star className="inline h-3 w-3 text-gold" /> P{c.priority} · {c.click_action?.type} · {fmtDate(c.start_date)} → {fmtDate(c.end_date)}
        </p>
      </div>
      <button onClick={() => onToggle(c)} data-testid={`artwork-toggle-${c.id}`} title="Toggle active"
              className="text-parchment hover:text-gold">
        {c.active ? <ToggleRight className="h-5 w-5 text-green-400" /> : <ToggleLeft className="h-5 w-5" />}
      </button>
      <button onClick={() => onEdit(c)} data-testid={`artwork-edit-${c.id}`} title="Edit"
              className="text-parchment hover:text-gold">
        <Pencil className="h-4 w-4" />
      </button>
      {confirm ? (
        <button onClick={() => onDelete(c)} data-testid={`artwork-delete-confirm-${c.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-red-300"
                style={{ background: "rgba(255,100,100,0.15)" }}>
          <Check className="h-3 w-3" /> Confirm
        </button>
      ) : (
        <button onClick={() => setConfirm(true)} data-testid={`artwork-delete-${c.id}`} title="Delete"
                className="text-red-300/70 hover:text-red-300">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default function ArtworkCampaignStudio() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // campaign or {} for new
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listArtworkCampaigns();
      setCampaigns(data.campaigns || []);
    } catch (e) {
      setErr(e.message || "Failed to load campaigns.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startNew = () => { setEditing(null); setShowForm(true); };
  const startEdit = (c) => {
    setEditing({ ...c, click_action: c.click_action || { type: "topup", value: "" } });
    setShowForm(true);
  };
  const handleSaved = () => { setShowForm(false); setEditing(null); load(); };

  const handleToggle = async (c) => {
    try {
      await updateArtworkCampaign(c.id, { ...c, active: !c.active });
      load();
    } catch (e) { setErr(e.message); }
  };
  const handleDelete = async (c) => {
    try { await deleteArtworkCampaign(c.id); load(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div data-testid="artwork-campaign-studio">
      <div className="flex items-center gap-3 mb-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl"
             style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
          <ImageIcon className="h-5 w-5 text-gold" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-parchment">Artwork Campaigns</h2>
          <p className="text-[11.5px] text-faded">Upload-by-link promotional artwork. The Library adapts each image per placement automatically.</p>
        </div>
        <button onClick={load} data-testid="artwork-refresh"
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {!showForm && (
          <button onClick={startNew} data-testid="artwork-new"
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
                  style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> New campaign
          </button>
        )}
      </div>

      {showForm && (
        <CampaignForm initial={editing} onSaved={handleSaved} onCancel={() => { setShowForm(false); setEditing(null); }} />
      )}

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }}>
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-faded">Loading campaigns…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gold/30 px-6 py-12 text-center"
             style={{ background: "rgba(34,24,48,0.4)" }} data-testid="artwork-empty">
          <ImageIcon className="mx-auto h-8 w-8 text-gold/70" />
          <p className="mt-3 font-display text-[16px] text-parchment">No artwork campaigns yet</p>
          <p className="mt-1 text-[12px] text-faded">Create your first campaign to feature it across the student experience.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="artwork-list">
          {campaigns.map((c) => (
            <CampaignRow key={c.id} c={c}
                         onEdit={startEdit} onToggle={handleToggle} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
