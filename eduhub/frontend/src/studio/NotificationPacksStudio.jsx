/**
 * NotificationPacksStudio.jsx — Author Studio's "Notification Packs"
 * screen (architecture.md continuation: "Notification Packs UI (push/
 * event/reminder/reward templates)"). Author reusable {placeholder}-
 * templated title/body/url packs that an Event Template's
 * notification_pack_ref can point at. This screen only AUTHORS and
 * PREVIEWS packs — it never sends anything; notification_center.py's
 * existing delivery pipeline is untouched.
 *
 * Backend: notification_packs.py, mounted at /api/v1/notification-packs*.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, RefreshCw, Save, Eye } from "lucide-react";
import {
  listNotificationPacks, createNotificationPack, updateNotificationPack,
  publishNotificationPack, unpublishNotificationPack, archiveNotificationPack,
  deleteNotificationPack, previewNotificationPack,
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
const TYPES = ["push", "event", "reminder", "reward"];

/* ── Create-pack form ─────────────────────────────────────────────────── */
function CreateForm({ onCreated }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("push");
  const [titleTemplate, setTitleTemplate] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [urlTemplate, setUrlTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleCreate = async () => {
    setErr(null);
    setSaving(true);
    try {
      await createNotificationPack({
        name: name.trim(), type,
        title_template: titleTemplate.trim(),
        body_template: bodyTemplate.trim(),
        url_template: urlTemplate.trim(),
      });
      setName(""); setTitleTemplate(""); setBodyTemplate(""); setUrlTemplate("");
      onCreated();
    } catch (e) {
      setErr(e.message || "Create failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-parchment">Add a notification pack</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Mystery Box Win"
                 data-testid="notification-packs-new-name-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}
                  data-testid="notification-packs-new-type-select"
                  className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          URL template (optional)
          <input value={urlTemplate} onChange={(e) => setUrlTemplate(e.target.value)}
                 placeholder="/portal/{eventId}"
                 data-testid="notification-packs-new-url-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-faded">
        Title template
        <input value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)}
               placeholder="Hi {studentName}!"
               data-testid="notification-packs-new-title-input"
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-faded">
        Body template
        <input value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)}
               placeholder="You won {points} points from {source}."
               data-testid="notification-packs-new-body-input"
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </label>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <button disabled={saving} onClick={handleCreate}
              data-testid="notification-packs-create-button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
        <Save className="h-3.5 w-3.5" /> {saving ? "Adding…" : "Add pack"}
      </button>
    </div>
  );
}

/* ── Edit form (inline, draft-only) ───────────────────────────────────── */
function EditForm({ pack, onSaved, onCancel }) {
  const [titleTemplate, setTitleTemplate] = useState(pack.title_template);
  const [bodyTemplate, setBodyTemplate] = useState(pack.body_template);
  const [urlTemplate, setUrlTemplate] = useState(pack.url_template || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      await updateNotificationPack(pack._id, {
        title_template: titleTemplate.trim(), body_template: bodyTemplate.trim(), url_template: urlTemplate.trim(),
      });
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <input value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)}
             data-testid={`notification-packs-edit-title-${pack._id}`}
             className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full" />
      <input value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)}
             data-testid={`notification-packs-edit-body-${pack._id}`}
             className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full" />
      <input value={urlTemplate} onChange={(e) => setUrlTemplate(e.target.value)}
             data-testid={`notification-packs-edit-url-${pack._id}`}
             className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment w-full" />
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSave}
                data-testid={`notification-packs-save-${pack._id}`}
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

/* ── Preview panel ─────────────────────────────────────────────────────── */
function PreviewPanel({ pack, onClose }) {
  const [contextRaw, setContextRaw] = useState('{"studentName": "Sok", "points": 50}');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const handlePreview = async () => {
    setErr(null);
    let context;
    try {
      context = JSON.parse(contextRaw);
    } catch {
      setErr("Not valid JSON.");
      return;
    }
    setLoading(true);
    try {
      const data = await previewNotificationPack(pack._id, context);
      setResult(data.preview);
    } catch (e) {
      setErr(e.message || "Preview failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2" data-testid={`notification-packs-preview-${pack._id}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-parchment">Preview — {pack.name}</div>
        <button onClick={onClose} className="text-xs text-faded hover:text-parchment">Close</button>
      </div>
      <textarea value={contextRaw} onChange={(e) => setContextRaw(e.target.value)}
                data-testid={`notification-packs-preview-context-${pack._id}`}
                rows={2}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs font-mono text-parchment" />
      <button disabled={loading} onClick={handlePreview}
              data-testid={`notification-packs-preview-run-${pack._id}`}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-faded hover:text-parchment hover:bg-white/10">
        <Eye className="h-3.5 w-3.5" /> {loading ? "Rendering…" : "Render preview"}
      </button>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {result && (
        <div className="rounded-lg bg-white/5 p-2 text-xs text-parchment space-y-1" data-testid={`notification-packs-preview-result-${pack._id}`}>
          <div><span className="text-faded">Title:</span> {result.title}</div>
          <div><span className="text-faded">Body:</span> {result.body}</div>
          <div><span className="text-faded">URL:</span> {result.url}</div>
        </div>
      )}
    </div>
  );
}

/* ── Pack row ──────────────────────────────────────────────────────────── */
function PackRow({ pack, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`notification-packs-row-${pack._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-parchment">{pack.name}</span>
          <Badge color="gold">{pack.type}</Badge>
          <Badge color={STATUS_COLOR[pack.status] || "muted"}>{pack.status}</Badge>
          <span className="text-xs text-faded">v{pack.version ?? 1}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button disabled={busy} onClick={() => setPreviewing((v) => !v)}
                  data-testid={`notification-packs-preview-toggle-${pack._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            <Eye className="h-3 w-3" /> Preview
          </button>
          {pack.status === "draft" && (
            <button disabled={busy} onClick={() => setEditing((v) => !v)}
                    data-testid={`notification-packs-edit-${pack._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Edit
            </button>
          )}
          {pack.status !== "published" && pack.status !== "archived" && (
            <button disabled={busy} onClick={() => run(() => publishNotificationPack(pack._id))}
                    data-testid={`notification-packs-publish-${pack._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Publish
            </button>
          )}
          {pack.status === "published" && (
            <button disabled={busy} onClick={() => run(() => unpublishNotificationPack(pack._id))}
                    data-testid={`notification-packs-unpublish-${pack._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Unpublish
            </button>
          )}
          {pack.status !== "archived" && (
            <button disabled={busy} onClick={() => run(() => archiveNotificationPack(pack._id))}
                    data-testid={`notification-packs-archive-${pack._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Archive
            </button>
          )}
          {pack.status !== "published" && (
            <button disabled={busy} onClick={() => run(() => deleteNotificationPack(pack._id))}
                    data-testid={`notification-packs-delete-${pack._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-red-400 hover:bg-red-500/10">
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 text-xs text-faded space-y-0.5">
        <div>Title: <span className="text-parchment">{pack.title_template}</span></div>
        <div>Body: <span className="text-parchment">{pack.body_template}</span></div>
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {editing && (
        <div className="mt-3">
          <EditForm pack={pack} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
        </div>
      )}
      {previewing && (
        <div className="mt-3">
          <PreviewPanel pack={pack} onClose={() => setPreviewing(false)} />
        </div>
      )}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────── */
export default function NotificationPacksStudio() {
  const [packs, setPacks] = useState([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listNotificationPacks({ type: type || undefined, status: status || undefined });
      setPacks(data.packs || []);
    } catch (e) {
      setErr(e.message || "Failed to load notification packs.");
    } finally {
      setLoading(false);
    }
  }, [type, status]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment flex items-center gap-2">
            <Bell className="h-5 w-5" /> Notification Packs
          </h2>
          <p className="text-xs text-faded">
            Reusable {"{placeholder}"}-templated title/body/url packs an Event Template can reference. Preview renders the template only — nothing is sent from here.
          </p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <CreateForm onCreated={reload} />

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-faded">
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}
                    data-testid="notification-packs-type-filter"
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment">
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}
                    data-testid="notification-packs-status-filter"
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
        <div className="text-sm font-semibold text-parchment mb-2">Packs</div>
        {loading ? (
          <div className="text-sm text-faded">Loading…</div>
        ) : packs.length === 0 ? (
          <div className="text-sm text-faded">No notification packs match these filters yet.</div>
        ) : (
          <div className="space-y-3">
            {packs.map((p) => (
              <PackRow key={p._id} pack={p} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
