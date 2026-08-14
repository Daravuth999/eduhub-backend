/**
 * AnnouncementsStudio.jsx — Author Studio › Announcements (Dashboard
 * Showcases, architecture continuation).
 *
 * Same Experience Configuration Platform every other Studio panel here
 * uses (experienceType="announcement", generic experience_configs CRUD +
 * draft/published lifecycle) — zero new backend infrastructure. Until a
 * config is Published here, the Dashboard's announcement ticker keeps
 * showing the legacy Google Apps Script content (see
 * legacyAnnouncementAdapter.js) exactly as it always has.
 *
 * Scoped to a single field the ticker actually reads:
 * content.announcementMessages (a plain string list) — no appearance/
 * motion/playback dials, since AnnouncementStrip.jsx has no such surface.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Megaphone, Plus, RefreshCw, Trash2, Pencil, X, Rocket, Undo2, Check, AlertTriangle,
} from "lucide-react";
import {
  listExperienceConfigs, createExperienceConfig, updateExperienceConfig,
  publishExperienceConfig, unpublishExperienceConfig, deleteExperienceConfig,
} from "./api";

const EXPERIENCE_TYPE = "announcement";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function ConfigForm({ initial, onSaved, onCancel }) {
  const [key, setKey] = useState(initial?.key || "default");
  const [messages, setMessages] = useState(
    initial?.content?.announcementMessages?.length ? [...initial.content.announcementMessages] : [""],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const setMessage = (i, v) => setMessages((m) => m.map((x, idx) => (idx === i ? v : x)));
  const addMessage = () => setMessages((m) => [...m, ""]);
  const removeMessage = (i) => setMessages((m) => m.filter((_, idx) => idx !== i));

  const handleSubmit = async () => {
    setErr(null);
    const cleaned = messages.map((m) => m.trim()).filter(Boolean);
    if (!cleaned.length) {
      return setErr("At least one announcement message is required.");
    }
    setSaving(true);
    try {
      const payload = { content: { announcementMessages: cleaned, visible: true } };
      if (initial && initial.id) {
        await updateExperienceConfig(initial.id, payload);
      } else {
        await createExperienceConfig({ experienceType: EXPERIENCE_TYPE, key: key || "default", ...payload });
      }
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gold/25 p-5 mb-6" style={{ background: "rgba(20,14,32,0.55)" }} data-testid="announcements-form">
      <div className="flex items-center gap-2 mb-4">
        <Megaphone className="h-4 w-4 text-gold" />
        <h3 className="font-display text-[15px] text-parchment">
          {initial && initial.id ? `Edit "${initial.key}"` : "New Announcements config"}
        </h3>
      </div>

      {!initial?.id && (
        <label className="block mb-3">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5">Key</span>
          <input value={key} onChange={(e) => setKey(e.target.value)}
                 data-testid="announcements-key-input"
                 className="w-full rounded-xl border border-gold/25 bg-black/40 px-3 py-2 text-[13px] text-parchment" />
        </label>
      )}

      <span className="block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5">Messages</span>
      <div className="space-y-2 mb-2">
        {messages.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={m} onChange={(e) => setMessage(i, e.target.value)}
                   data-testid={`announcements-message-input-${i}`}
                   placeholder="Announcement text"
                   className="flex-1 rounded-xl border border-gold/25 bg-black/40 px-3 py-2 text-[13px] text-parchment" />
            <button onClick={() => removeMessage(i)} data-testid={`announcements-remove-message-${i}`}
                    className="text-red-300/70 hover:text-red-300" title="Remove">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button onClick={addMessage} data-testid="announcements-add-message"
              className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold mb-4">
        <Plus className="h-3.5 w-3.5" /> Add message
      </button>

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="announcements-form-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSubmit} data-testid="announcements-save"
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
                style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} data-testid="announcements-cancel"
                className="rounded-full border border-gold/30 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfigRow({ c, onEdit, onPublish, onUnpublish, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const messages = c.content?.announcementMessages || [];
  return (
    <div className="rounded-2xl border border-gold/20 px-4 py-3 flex items-center justify-between gap-3"
         style={{ background: "rgba(34,24,48,0.4)" }} data-testid={`announcements-row-${c.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-display text-[13px] text-parchment">{c.key}</span>
          <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            c.status === "published" ? "text-emerald-300" : "text-faded"
          }`} style={{ background: c.status === "published" ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.06)" }}>
            {c.status}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] text-faded truncate">
          {messages.length} message{messages.length === 1 ? "" : "s"} · {messages[0] || ""}
        </p>
        <p className="text-[10.5px] text-faded/70">Updated {fmtDate(c.updatedAt)}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => onEdit(c)} data-testid={`announcements-edit-${c.id}`} title="Edit" className="text-faded hover:text-parchment">
          <Pencil className="h-4 w-4" />
        </button>
        {c.status === "published" ? (
          <button onClick={() => onUnpublish(c)} data-testid={`announcements-unpublish-${c.id}`}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-faded hover:text-parchment">
            <Undo2 className="h-3 w-3" /> Unpublish
          </button>
        ) : (
          <button onClick={() => onPublish(c)} data-testid={`announcements-publish-${c.id}`}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-emerald-300"
                  style={{ background: "rgba(16,185,129,0.12)" }}>
            <Rocket className="h-3 w-3" /> Publish
          </button>
        )}
        {confirm ? (
          <button onClick={() => onDelete(c)} data-testid={`announcements-delete-confirm-${c.id}`}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-red-300"
                  style={{ background: "rgba(255,100,100,0.15)" }}>
            <Check className="h-3 w-3" /> Confirm
          </button>
        ) : (
          <button onClick={() => setConfirm(true)} data-testid={`announcements-delete-${c.id}`} title="Delete" className="text-red-300/70 hover:text-red-300">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function AnnouncementsStudio() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listExperienceConfigs(EXPERIENCE_TYPE);
      setConfigs(data.configs || []);
    } catch (e) {
      setErr(e.message || "Failed to load configs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startNew = () => { setEditing(null); setShowForm(true); };
  const startEdit = (c) => { setEditing(c); setShowForm(true); };
  const handleSaved = () => { setShowForm(false); setEditing(null); load(); };

  const handlePublish = async (c) => {
    try { await publishExperienceConfig(c.id); load(); } catch (e) { setErr(e.message); }
  };
  const handleUnpublish = async (c) => {
    try { await unpublishExperienceConfig(c.id); load(); } catch (e) { setErr(e.message); }
  };
  const handleDelete = async (c) => {
    try {
      await deleteExperienceConfig(c.id, { force: c.status === "published" });
      load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div data-testid="announcements-studio">
      <div className="flex items-center gap-3 mb-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl"
             style={{ background: "linear-gradient(150deg,#2D1F3E,#1A1420)", border: "1px solid rgba(212,168,67,0.25)" }}>
          <Megaphone className="h-5 w-5 text-gold" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-parchment">Announcements</h2>
          <p className="text-[11.5px] text-faded">
            Configure the Dashboard announcement ticker. Until a config is Published here, the
            ticker keeps showing the legacy Google Apps Script content.
          </p>
        </div>
        <button onClick={load} data-testid="announcements-refresh"
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {!showForm && (
          <button onClick={startNew} data-testid="announcements-new"
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
                  style={{ background: "linear-gradient(135deg,#FFE19A 0%,#D4A843 50%,#9C7A2C 100%)" }}>
            <Plus className="h-3.5 w-3.5" /> New config
          </button>
        )}
      </div>

      {showForm && (
        <ConfigForm initial={editing} onSaved={handleSaved} onCancel={() => { setShowForm(false); setEditing(null); }} />
      )}

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="announcements-list-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-faded">Loading configs…</p>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gold/30 px-6 py-12 text-center"
             style={{ background: "rgba(34,24,48,0.4)" }} data-testid="announcements-empty">
          <Megaphone className="mx-auto h-8 w-8 text-gold/70" />
          <p className="mt-3 font-display text-[16px] text-parchment">No Announcements configs yet</p>
          <p className="mt-1 text-[12px] text-faded">The ticker is currently driven by the legacy Google Apps Script content. Create one to take over.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="announcements-list">
          {configs.map((c) => (
            <ConfigRow key={c.id} c={c}
                       onEdit={startEdit} onPublish={handlePublish} onUnpublish={handleUnpublish}
                       onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
