/**
 * DashboardStudio.jsx — Author Studio › Dashboard Studio.
 *
 * The SCALABLE framework future Dashboard experiences live inside, not a
 * one-off "Today's Discovery" editor. This file owns exactly ONE thing:
 * a generic list -> edit -> preview -> publish shell, parameterized over
 * whichever experienceType descriptor is selected from
 * dashboardExperienceRegistry.js. It has zero knowledge of what
 * "Today's Discovery" is — it only knows a descriptor has a label, an
 * icon, a default config, a FormFields component, and a Preview
 * component. Adding a future Dashboard experience (Community Spotlight,
 * Learning Challenge, Seasonal Artwork, ...) means adding ONE entry to
 * that registry file — never a new Studio page, never new CRUD, never a
 * new preview mechanism.
 *
 * Every data operation below is the SAME generic Experience Configuration
 * Platform CRUD every other Studio panel here uses
 * (listExperienceConfigs / createExperienceConfig / updateExperienceConfig
 * / publishExperienceConfig / unpublishExperienceConfig /
 * duplicateExperienceConfig / deleteExperienceConfig, all from "./api").
 * No Dashboard-specific endpoint exists or is introduced here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, RefreshCw, Plus, Save, Rocket, Undo2, Trash2, Pencil,
  Copy, X, AlertTriangle, Eye,
} from "lucide-react";
import {
  listExperienceConfigs, createExperienceConfig, updateExperienceConfig,
  publishExperienceConfig, unpublishExperienceConfig, duplicateExperienceConfig,
  deleteExperienceConfig,
} from "./api";
import { DASHBOARD_EXPERIENCE_TYPES } from "./dashboardExperiences/dashboardExperienceRegistry";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

/** Generic draft editor — delegates content-specific fields and preview
 *  to the active type's descriptor; owns only key/save/publish plumbing
 *  every experienceType shares. */
function ConfigForm({ type, initial, onSaved, onCancel }) {
  const [form, setForm] = useState(() => (initial ? {
    content: initial.content, appearance: initial.appearance,
    motion: initial.motion, playback: initial.playback,
  } : type.defaultConfig()));
  const [key, setKey] = useState(initial?.key || "default");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      if (initial?.id) {
        await updateExperienceConfig(initial.id, form);
      } else {
        await createExperienceConfig({ experienceType: type.id, key: key || "default", ...form });
      }
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const FormFields = type.FormFields;
  const Preview = type.Preview;

  return (
    <div className="rounded-2xl border border-gold/25 p-5 mb-6" style={{ background: "rgba(20,14,32,0.55)" }} data-testid="dashboardstudio-form">
      <div className="flex items-center gap-2 mb-4">
        <type.Icon className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px] text-parchment">
          {initial?.id ? `Edit "${initial.key}"` : `New ${type.label} config`}
        </h3>
        <div className="flex-1" />
        {onCancel && (
          <button onClick={onCancel} data-testid="dashboardstudio-form-cancel" className="text-faded hover:text-parchment">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {!initial?.id && (
        <label className="block mb-4">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5">
            Key (identifies this variant, e.g. &quot;default&quot; or &quot;lunar-new-year&quot;)
          </span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="dashboardstudio-key-input"
            className="w-full rounded-xl border border-gold/25 bg-black/40 px-3 py-2 text-[13px] text-parchment"
          />
        </label>
      )}

      {/* RC2 — preview-first editing surface (Canva/Framer-style: what you
          see is the primary panel, properties are secondary), without
          touching the generic list->edit->preview->publish architecture
          this shell already owns. The ONLY change is which panel comes
          first in DOM order — since this is a CSS grid, that's also which
          column it lands in on desktop, and which block stacks on top on
          mobile, so one reorder satisfies both "preview first on mobile"
          and "preview in the primary (left) position on desktop." Every
          registered Dashboard experience type gets this for free; no
          per-type change needed. */}
      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gold mb-2">
            <Eye className="h-3.5 w-3.5" /> Live preview — exactly what students will see
          </p>
          <div
            className="rounded-2xl border border-gold/20 p-5 sm:p-7"
            style={{ background: "radial-gradient(120% 100% at 50% 0%, rgba(212,168,67,0.09) 0%, rgba(20,14,32,0.75) 55%, rgba(13,9,20,0.85) 100%)" }}
            data-testid="dashboardstudio-preview"
          >
            <Preview config={form} />
          </div>
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-faded mb-2">
            <Pencil className="h-3.5 w-3.5" /> Properties
          </p>
          <div data-testid="dashboardstudio-form-fields">
            <FormFields config={form} onChange={setForm} />
          </div>
        </div>
      </div>

      {err && (
        <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="dashboardstudio-form-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={handleSave} disabled={saving} data-testid="dashboardstudio-save"
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save draft"}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-faded">
        Saving never publishes. Nothing here is visible to students until you explicitly Publish it
        from the list below.
      </p>
    </div>
  );
}

/** Generic list row — status pill + edit/publish/unpublish/duplicate/delete,
 *  identical across every registered experience type. */
function ConfigRow({ type, c, onEdit, onPublish, onUnpublish, onDuplicate, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const published = c.status === "published";
  const summary = type.summarize ? type.summarize(c) : `Updated ${fmtDate(c.updatedAt)}`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gold/20 px-4 py-3"
         style={{ background: "rgba(20,14,32,0.5)" }} data-testid={`dashboardstudio-row-${c.id}`}>
      <div className="grid h-8 w-8 flex-none place-items-center rounded-lg"
           style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
        <type.Icon className="h-4 w-4 text-gold" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[13px] font-bold text-parchment">{c.key}</p>
          <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${published ? "text-emerald-300" : "text-faded"}`}
                style={{ background: published ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.06)" }}>
            {c.status}
          </span>
        </div>
        <p className="truncate text-[11px] text-faded">{summary}</p>
      </div>
      <button onClick={() => onEdit(c)} data-testid={`dashboardstudio-edit-${c.id}`} className="text-faded hover:text-gold" title="Edit">
        <Pencil className="h-4 w-4" />
      </button>
      <button onClick={() => onDuplicate(c)} data-testid={`dashboardstudio-duplicate-${c.id}`} className="text-faded hover:text-gold" title="Duplicate">
        <Copy className="h-4 w-4" />
      </button>
      {published ? (
        <button onClick={() => onUnpublish(c)} data-testid={`dashboardstudio-unpublish-${c.id}`} className="text-faded hover:text-gold" title="Unpublish">
          <Undo2 className="h-4 w-4" />
        </button>
      ) : (
        <button onClick={() => onPublish(c)} data-testid={`dashboardstudio-publish-${c.id}`} className="text-faded hover:text-gold" title="Publish">
          <Rocket className="h-4 w-4" />
        </button>
      )}
      {confirmDelete ? (
        <button onClick={() => onDelete(c)} data-testid={`dashboardstudio-delete-confirm-${c.id}`}
                className="rounded-full px-2 py-1 text-[10px] font-bold text-red-300" style={{ background: "rgba(255,100,100,0.15)" }}>
          Confirm
        </button>
      ) : (
        <button onClick={() => setConfirmDelete(true)} data-testid={`dashboardstudio-delete-${c.id}`} className="text-red-300/70 hover:text-red-300" title="Delete">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default function DashboardStudio() {
  const [activeTypeId, setActiveTypeId] = useState(DASHBOARD_EXPERIENCE_TYPES[0]?.id);
  const type = useMemo(
    () => DASHBOARD_EXPERIENCE_TYPES.find((t) => t.id === activeTypeId) || DASHBOARD_EXPERIENCE_TYPES[0],
    [activeTypeId],
  );

  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    if (!type) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await listExperienceConfigs(type.id);
      setConfigs(res?.configs || []);
    } catch (e) {
      setErr(e.message || "Failed to load configs.");
      setConfigs([]);
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    setShowForm(false);
    setEditing(null);
    load();
  }, [load]);

  const startNew = () => { setEditing(null); setShowForm(true); };
  const startEdit = (c) => { setEditing(c); setShowForm(true); };
  const handleSaved = () => { setShowForm(false); setEditing(null); load(); };

  const guard = (fn) => async (c) => {
    try { await fn(c); load(); } catch (e) { setErr(e.message || "Action failed."); }
  };
  const handlePublish = guard((c) => publishExperienceConfig(c.id));
  const handleUnpublish = guard((c) => unpublishExperienceConfig(c.id));
  const handleDuplicate = guard((c) => duplicateExperienceConfig(c.id));
  const handleDelete = guard((c) => deleteExperienceConfig(c.id, { force: c.status === "published" }));

  if (!type) return null;

  return (
    <div data-testid="dashboard-studio">
      {/* Type switcher — one nav area, one editing experience, however
          many Dashboard experience types are registered. */}
      <div className="flex flex-wrap gap-1.5 mb-5" data-testid="dashboardstudio-type-switcher">
        {DASHBOARD_EXPERIENCE_TYPES.map((t) => {
          const active = t.id === activeTypeId;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTypeId(t.id)}
              data-testid={`dashboardstudio-type-${t.id}`}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
              style={{
                background: active ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" : "rgba(45,31,62,0.65)",
                color: active ? "#1a1420" : "#F4E5C1",
                border: active ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
              }}
            >
              <t.Icon className="h-3 w-3" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl"
             style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
          <type.Icon className="h-5 w-5 text-gold" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-parchment">{type.label}</h2>
          <p className="text-[11.5px] text-faded">{type.description}</p>
        </div>
        <button onClick={load} data-testid="dashboardstudio-refresh"
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {!showForm && (
          <button onClick={startNew} data-testid="dashboardstudio-new"
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
                  style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> New config
          </button>
        )}
      </div>

      {showForm && (
        <ConfigForm type={type} initial={editing} onSaved={handleSaved}
                    onCancel={() => { setShowForm(false); setEditing(null); }} />
      )}

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="dashboardstudio-list-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-faded">Loading configs…</p>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gold/30 px-6 py-12 text-center"
             style={{ background: "rgba(34,24,48,0.4)" }} data-testid="dashboardstudio-empty">
          <LayoutDashboard className="mx-auto h-8 w-8 text-gold/70" />
          <p className="mt-3 font-display text-[16px] text-parchment">No {type.label} configs yet</p>
          <p className="mt-1 text-[12px] text-faded">Create one — the Dashboard section stays hidden until it's published.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="dashboardstudio-list">
          {configs.map((c) => (
            <ConfigRow key={c.id} type={type} c={c}
                       onEdit={startEdit} onPublish={handlePublish} onUnpublish={handleUnpublish}
                       onDuplicate={handleDuplicate} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
