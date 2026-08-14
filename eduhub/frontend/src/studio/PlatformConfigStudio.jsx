/**
 * PlatformConfigStudio.jsx — Author Studio's "Platform Configuration"
 * screen (architecture.md §4.4, "Configuration Platform"). Exposes
 * eduhub_platform/config.py's 3-tier flag resolver (published override >
 * environment fallback > default fallback) with audit history and version
 * display, matching the approved architecture's exact capability list:
 * list entries, view effective values, create/edit/delete override,
 * audit history, version display.
 *
 * Backend: eduhub_platform/config.py, mounted at /api/v1/platform-config*.
 */
import { useCallback, useEffect, useState } from "react";
import { Settings, RefreshCw, Search, Trash2, History, Save, X } from "lucide-react";
import {
  listPlatformConfig, getPlatformConfig, setPlatformConfig,
  clearPlatformConfig, getPlatformConfigHistory,
} from "./api";

function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

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

const SOURCE_COLOR = { published: "gold", legacy: "blue", default: "muted" };
const SOURCE_LABEL = { published: "Published override", legacy: "Environment fallback", default: "Default fallback" };

/* ── Lookup panel: resolve any flag by name, even one with no override yet ── */
function LookupPanel({ onOpen }) {
  const [name, setName] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleLookup = async () => {
    setErr(null);
    if (!name.trim()) { setErr("Flag name is required."); return; }
    setLoading(true);
    try {
      const data = await getPlatformConfig(name.trim(), { envVar: envVar.trim(), defaultValue });
      setResult(data);
    } catch (e) {
      setErr(e.message || "Lookup failed.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-parchment">Look up any flag</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded">
          Flag name
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="USE_MONGO_POINTS_READ"
                 data-testid="platform-config-lookup-name-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Env var override (optional)
          <input value={envVar} onChange={(e) => setEnvVar(e.target.value)}
                 placeholder="defaults to flag name"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Default (if nothing else set)
          <input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)}
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
      </div>
      <button disabled={loading} onClick={handleLookup}
              data-testid="platform-config-lookup-button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
        <Search className="h-3.5 w-3.5" /> {loading ? "Looking up…" : "Resolve"}
      </button>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {result && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2" data-testid="platform-config-lookup-result">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-parchment">{result.effective_value ?? "(none)"}</span>
            <Badge color={SOURCE_COLOR[result.source] || "muted"}>{SOURCE_LABEL[result.source] || result.source}</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-faded">
            <div>Published: <span className="text-parchment">{result.published_override ?? "—"}</span> {result.override_version ? `(v${result.override_version})` : ""}</div>
            <div>Environment: <span className="text-parchment">{result.environment_fallback ?? "—"}</span></div>
            <div>Default: <span className="text-parchment">{result.default_fallback ?? "—"}</span></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onOpen(name.trim())}
                    data-testid="platform-config-lookup-manage-button"
                    className="text-xs text-faded hover:text-parchment underline">
              Manage this override
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Set/edit override form ───────────────────────────────────────────── */
function OverrideForm({ name, currentValue, onSaved, onCancel }) {
  const [value, setValue] = useState(currentValue ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleSave = async () => {
    setErr(null);
    setSaving(true);
    try {
      await setPlatformConfig(name, value);
      onSaved();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <label className="flex flex-col gap-1 text-xs text-faded">
        Override value for "{name}"
        <input value={value} onChange={(e) => setValue(e.target.value)}
               data-testid="platform-config-override-value-input"
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </label>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={saving} onClick={handleSave}
                data-testid="platform-config-override-save-button"
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save override"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── History panel ───────────────────────────────────────────────────── */
function HistoryPanel({ name, onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPlatformConfigHistory(name)
      .then((data) => { if (!cancelled) setHistory(data.history || []); })
      .catch((e) => { if (!cancelled) setErr(e.message || "Failed to load history."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [name]);

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2" data-testid={`platform-config-history-${name}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-parchment">Audit history — {name}</div>
        <button onClick={onClose} className="text-xs text-faded hover:text-parchment">Close</button>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {loading ? (
        <div className="text-xs text-faded">Loading…</div>
      ) : history.length === 0 ? (
        <div className="text-xs text-faded">No changes recorded yet.</div>
      ) : (
        <div className="space-y-1.5">
          {history.map((h, i) => (
            <div key={i} className="text-xs text-faded flex flex-wrap items-center gap-1.5">
              <Badge color={h.action === "clear" ? "muted" : "green"}>{h.action}</Badge>
              <span className="text-parchment">{h.old_value ?? "(none)"}</span>
              {" → "}
              <span className="text-parchment">{h.new_value ?? "(none)"}</span>
              <span>by {h.by || "unknown"}</span>
              <span>· {fmt(h.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Override row ─────────────────────────────────────────────────────── */
function OverrideRow({ override, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const handleClear = async () => {
    setErr(null);
    setBusy(true);
    try {
      await clearPlatformConfig(override._id);
      onChanged();
    } catch (e) {
      setErr(e.message || "Clear failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`platform-config-row-${override._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-parchment font-mono">{override._id}</span>
          <Badge color="gold">v{override.version ?? 1}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button disabled={busy} onClick={() => setEditing((v) => !v)}
                  data-testid={`platform-config-edit-${override._id}`}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            Edit
          </button>
          <button disabled={busy} onClick={() => setShowHistory((v) => !v)}
                  data-testid={`platform-config-history-toggle-${override._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            <History className="h-3 w-3" /> History
          </button>
          <button disabled={busy} onClick={handleClear}
                  data-testid={`platform-config-clear-${override._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-red-400 hover:bg-red-500/10">
            <Trash2 className="h-3 w-3" /> Clear
          </button>
        </div>
      </div>
      <div className="mt-2 text-xs text-faded">
        Value: <span className="text-parchment">{String(override.value)}</span>
        {" · "}Updated {fmt(override.updated_at)} by {override.updated_by || "unknown"}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {editing && (
        <div className="mt-3">
          <OverrideForm name={override._id} currentValue={override.value}
                        onSaved={() => { setEditing(false); onChanged(); }}
                        onCancel={() => setEditing(false)} />
        </div>
      )}
      {showHistory && (
        <div className="mt-3">
          <HistoryPanel name={override._id} onClose={() => setShowHistory(false)} />
        </div>
      )}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────── */
export default function PlatformConfigStudio() {
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [newName, setNewName] = useState(null); // name being created via lookup->manage

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listPlatformConfig();
      setOverrides(data.overrides || []);
    } catch (e) {
      setErr(e.message || "Failed to load platform configuration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment flex items-center gap-2">
            <Settings className="h-5 w-5" /> Platform Configuration
          </h2>
          <p className="text-xs text-faded">
            Advanced — developer feature flags, not needed for day-to-day administration.
            Every flag resolves published override → environment fallback → code default. Overrides take effect immediately, no redeploy.
          </p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <LookupPanel onOpen={(name) => setNewName(name)} />

      {newName && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-parchment">New override</div>
            <button onClick={() => setNewName(null)}><X className="h-4 w-4 text-faded" /></button>
          </div>
          <OverrideForm name={newName} currentValue=""
                        onSaved={() => { setNewName(null); reload(); }}
                        onCancel={() => setNewName(null)} />
        </div>
      )}

      {err && <div className="text-xs text-red-400">{err}</div>}

      <div>
        <div className="text-sm font-semibold text-parchment mb-2">Active overrides</div>
        {loading ? (
          <div className="text-sm text-faded">Loading…</div>
        ) : overrides.length === 0 ? (
          <div className="text-sm text-faded">No published overrides yet — every flag is using its environment or default value.</div>
        ) : (
          <div className="space-y-3">
            {overrides.map((o) => (
              <OverrideRow key={o._id} override={o} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
