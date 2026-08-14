/**
 * CampaignDesignStudio.jsx — EduHub Campaign Design Studio 2.0.
 *
 * Canvas-first reconstruction of the Promotion Experience Studio: the live
 * canvas IS the editor. Mounted by PromotionExperienceStudio.jsx on the
 * SAME `/studio` tab ("promotionexp") — one authoring experience, same
 * route, same data contract.
 *
 * Data contract (unchanged from the form era):
 *   • generic experience-configs API, experienceType="promotional_banner"
 *   • draft never live until Published
 *   • canvas documents live at content.canvas (schemaVersion 2); legacy
 *     content fields are PRESERVED on save so rollback stays possible
 *   • legacy (form-era) configs open through a non-destructive
 *     convert-to-canvas migration (editorState.migrateLegacyToCanvas)
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import {
  Megaphone, Plus, RefreshCw, Trash2, Pencil, Copy,
  Loader2, AlertTriangle, Check, Layers as LayersIcon, Shapes, LayoutTemplate,
  SlidersHorizontal, CalendarClock, X,
} from "lucide-react";
import {
  listExperienceConfigs, createExperienceConfig, updateExperienceConfig,
  publishExperienceConfig, unpublishExperienceConfig,
  duplicateExperienceConfig, deleteExperienceConfig,
} from "../api";
import CampaignCanvasRenderer from "../../eduhub/components/campaign/CampaignCanvasRenderer";
import { isCanvasConfig, makeDefaultCanvas } from "../../eduhub/lib/campaignCanvas/canvasSchema";
import { editorReducer, initialEditorState, migrateLegacyToCanvas } from "./editorState";
import CanvasStage from "./CanvasStage";
import TopBar, { DEVICES } from "./TopBar";
import LayersPanel from "./panels/LayersPanel";
import AssetLibraryPanel from "./panels/AssetLibraryPanel";
import TemplatesPanel from "./panels/TemplatesPanel";
import InspectorPanel from "./panels/InspectorPanel";

const EXPERIENCE_TYPE = "promotional_banner";

const LEFT_TABS = [
  { id: "layers", label: "Layers", Icon: LayersIcon },
  { id: "assets", label: "Assets", Icon: Shapes },
  { id: "templates", label: "Add", Icon: LayoutTemplate },
];

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function toInputDatetime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(0, 16); } catch { return ""; }
}

/* ────────────────────── campaign browser ────────────────────── */
function CampaignBrowser({ configs, loading, error, onRefresh, onCreate, onEdit, onDuplicate, onDelete, busyId }) {
  const [newKey, setNewKey] = useState("");
  return (
    <div data-testid="campaign-browser">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-gold" />
          <div>
            <h2 className="font-display text-[18px] text-parchment">Campaign Design Studio</h2>
            <p className="text-[11px] text-faded">Canvas-first campaigns · published straight to the Dashboard promotion slot</p>
          </div>
        </div>
        <div className="flex-1" />
        <button type="button" onClick={onRefresh} data-testid="campaign-refresh-button"
                className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5 rounded-2xl p-3"
           style={{ background: "rgba(20,14,32,0.6)", border: "1px solid rgba(212,168,67,0.2)" }}>
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="new-campaign-key (e.g. topup-march)"
          data-testid="campaign-new-key-input"
          className="flex-1 min-w-[200px] rounded-full px-4 py-2 text-[12px] outline-none"
          style={{ background: "rgba(13,10,22,0.8)", border: "1px solid rgba(212,168,67,0.25)", color: "#F4E5C1" }}
        />
        <button type="button" data-testid="campaign-create-button"
                onClick={() => { onCreate(newKey.trim() || undefined); setNewKey(""); }}
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "linear-gradient(135deg,#FFE19A,#D4A843,#9C7A2C)", color: "#1a1420", boxShadow: "0 6px 14px rgba(212,168,67,0.3)" }}>
          <Plus className="h-3.5 w-3.5" /> New campaign
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-[12px]"
             style={{ background: "rgba(178,58,72,0.12)", border: "1px solid rgba(178,58,72,0.4)", color: "#F3C9CE" }}
             data-testid="campaign-browser-error">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="grid place-items-center py-16" data-testid="campaign-browser-loading">
          <Loader2 className="h-6 w-6 animate-spin text-gold" />
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-2xl px-6 py-12 text-center" style={{ background: "rgba(20,14,32,0.5)", border: "1px dashed rgba(212,168,67,0.3)" }}>
          <Megaphone className="h-8 w-8 text-gold/60 mx-auto mb-3" />
          <p className="text-[13px] text-parchment mb-1">No campaigns yet</p>
          <p className="text-[11px] text-faded">Create your first canvas campaign — start from a premium template in the editor.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {configs.map((c) => {
            const isCanvas = isCanvasConfig(c);
            const busy = busyId === c.id;
            return (
              <div key={c.id} className="rounded-2xl overflow-hidden"
                   style={{ background: "rgba(20,14,32,0.6)", border: "1px solid rgba(212,168,67,0.22)" }}
                   data-testid={`campaign-card-${c.key}`}>
                {/* role=button div, NOT <button>: the live canvas preview can
                    contain a CTA <button> layer, and <button> may not nest
                    inside <button> (invalid DOM; React warns). */}
                <div
                  role="button"
                  tabIndex={0}
                  className="w-full text-left cursor-pointer"
                  onClick={() => onEdit(c)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onEdit(c); } }}
                  data-testid={`campaign-open-${c.key}`}
                >
                  <div className="pointer-events-none">
                    {isCanvas ? (
                      <CampaignCanvasRenderer canvas={c.content.canvas} appTheme="dark" animateEnabled={false} editMode />
                    ) : (
                      <div className="grid place-items-center" style={{ aspectRatio: "21/9", background: "linear-gradient(155deg,#0B1712,#123F2C)" }}>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-parchment/70">Legacy campaign · opens with canvas migration</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-bold text-parchment truncate">{c.key}</p>
                      <span className="rounded-full px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-wider"
                            style={c.status === "published"
                              ? { background: "rgba(46,125,91,0.25)", color: "#8FD6B2", border: "1px solid rgba(46,125,91,0.5)" }
                              : { background: "rgba(244,229,193,0.08)", color: "rgba(244,229,193,0.7)", border: "1px solid rgba(244,229,193,0.2)" }}
                            data-testid={`campaign-status-${c.key}`}>
                        {c.status}
                      </span>
                      {!isCanvas && (
                        <span className="rounded-full px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-wider"
                              style={{ background: "rgba(58,110,165,0.2)", color: "#A9C6E8", border: "1px solid rgba(58,110,165,0.45)" }}>
                          legacy
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-faded">v{c.version} · updated {fmtDate(c.updatedAt)}</p>
                  </div>
                  <button type="button" title="Edit" aria-label="Edit campaign" onClick={() => onEdit(c)}
                          className="grid place-items-center h-8 w-8 rounded-full text-faded hover:text-gold"
                          style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.2)" }}
                          data-testid={`campaign-edit-${c.key}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="Duplicate" aria-label="Duplicate campaign" disabled={busy} onClick={() => onDuplicate(c)}
                          className="grid place-items-center h-8 w-8 rounded-full text-faded hover:text-gold"
                          style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.2)" }}
                          data-testid={`campaign-duplicate-${c.key}`}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" title="Delete" aria-label="Delete campaign" disabled={busy} onClick={() => onDelete(c)}
                          className="grid place-items-center h-8 w-8 rounded-full text-faded hover:text-red-300"
                          style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.2)" }}
                          data-testid={`campaign-delete-${c.key}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ────────────────────── scheduling strip ────────────────────── */
function SchedulingStrip({ activeWindow, onChange }) {
  const [open, setOpen] = useState(false);
  const w = activeWindow || { startsAt: "", endsAt: "", recurringAnnual: false };
  return (
    <div className="rounded-2xl px-3 py-2 mb-3" style={{ background: "rgba(20,14,32,0.6)", border: "1px solid rgba(212,168,67,0.18)" }}>
      <button type="button" onClick={() => setOpen(!open)} data-testid="campaign-scheduling-toggle"
              className="flex items-center gap-2 w-full text-left">
        <CalendarClock className="h-3.5 w-3.5 text-gold" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-parchment">Scheduling</span>
        <span className="text-[10px] text-faded flex-1 truncate">
          {w.startsAt || w.endsAt ? `${w.startsAt ? fmtDate(w.startsAt) : "now"} → ${w.endsAt ? fmtDate(w.endsAt) : "forever"}${w.recurringAnnual ? " · annual" : ""}` : "Always active while published"}
        </span>
      </button>
      {open && (
        <div className="flex flex-wrap items-end gap-3 mt-3">
          <label className="text-[10px] text-faded">
            Starts
            <input type="datetime-local" value={toInputDatetime(w.startsAt)} data-testid="campaign-schedule-start"
                   onChange={(e) => onChange({ ...w, startsAt: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                   className="block mt-1 rounded-lg px-2 py-1.5 text-[11px]"
                   style={{ background: "rgba(13,10,22,0.8)", border: "1px solid rgba(212,168,67,0.25)", color: "#F4E5C1" }} />
          </label>
          <label className="text-[10px] text-faded">
            Ends
            <input type="datetime-local" value={toInputDatetime(w.endsAt)} data-testid="campaign-schedule-end"
                   onChange={(e) => onChange({ ...w, endsAt: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                   className="block mt-1 rounded-lg px-2 py-1.5 text-[11px]"
                   style={{ background: "rgba(13,10,22,0.8)", border: "1px solid rgba(212,168,67,0.25)", color: "#F4E5C1" }} />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-faded pb-1.5">
            <input type="checkbox" checked={Boolean(w.recurringAnnual)} data-testid="campaign-schedule-annual"
                   onChange={(e) => onChange({ ...w, recurringAnnual: e.target.checked })}
                   className="accent-[#D4A843]" />
            Recurring annually
          </label>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── editor ────────────────────── */
function CampaignEditor({ config, onBack, onSaved, onStatusChange }) {
  const startedFromLegacy = !isCanvasConfig(config);
  const [state, dispatch] = useReducer(
    editorReducer,
    config,
    (cfg) => initialEditorState(isCanvasConfig(cfg) ? cfg.content.canvas : migrateLegacyToCanvas(cfg)),
  );
  const [meta, setMeta] = useState(config);
  const [activeWindow, setActiveWindow] = useState(config.activeWindow || { startsAt: "", endsAt: "", recurringAnnual: false });
  const [leftTab, setLeftTab] = useState("templates");
  const [device, setDevice] = useState("desktop");
  const [zoom, setZoom] = useState(1);
  const [previewTheme, setPreviewTheme] = useState("dark");
  const [showSafeArea, setShowSafeArea] = useState(true);
  const [motionPreviewKey, setMotionPreviewKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState(startedFromLegacy ? { kind: "info", text: "Legacy campaign converted to canvas (non-destructive — nothing is stored until you Save)." } : null);
  const [mobilePanel, setMobilePanel] = useState(null); // null | "left" | "inspector"

  const stageWidth = (DEVICES.find((d) => d.id === device)?.width || 980) * zoom;

  const flash = useCallback((kind, text) => {
    setNotice({ kind, text });
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setNotice(null), 3500);
  }, []);

  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      const payload = {
        content: {
          ...(meta.content || {}),
          visible: true,
          canvas: state.canvas,
        },
        appearance: meta.appearance || {},
        motion: { preset: state.canvas.motion?.preset || "layeredElegant" },
        activeWindow,
      };
      const r = await updateExperienceConfig(meta.id, payload);
      if (r?.config) {
        setMeta(r.config);
        dispatch({ type: "MARK_SAVED" });
        onSaved?.(r.config);
        flash("ok", "Saved.");
      }
      return r?.config;
    } catch (e) {
      flash("error", e?.message || "Save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }, [meta, state.canvas, activeWindow, onSaved, flash]);

  const doPublish = useCallback(async () => {
    setPublishing(true);
    try {
      const saved = await doSave();
      if (!saved) return;
      const r = await publishExperienceConfig(meta.id);
      if (r?.config) {
        setMeta(r.config);
        onStatusChange?.(r.config);
        flash("ok", "Published — live on the Dashboard.");
      }
    } catch (e) {
      flash("error", e?.message || "Publish failed");
    } finally {
      setPublishing(false);
    }
  }, [doSave, meta.id, onStatusChange, flash]);

  const doUnpublish = useCallback(async () => {
    setPublishing(true);
    try {
      const r = await unpublishExperienceConfig(meta.id);
      if (r?.config) {
        setMeta(r.config);
        onStatusChange?.(r.config);
        flash("ok", "Unpublished — back to draft.");
      }
    } catch (e) {
      flash("error", e?.message || "Unpublish failed");
    } finally {
      setPublishing(false);
    }
  }, [meta.id, onStatusChange, flash]);

  const applyTemplate = useCallback((template) => {
    dispatch({ type: "UPDATE_CANVAS", patch: template.build() });
    flash("ok", `Template “${template.label}” applied.`);
  }, [flash]);

  const leftPanelBody = (
    <>
      <div className="flex gap-1 mb-3">
        {LEFT_TABS.map(({ id, label, Icon }) => (
          <button key={id} type="button" onClick={() => setLeftTab(id)}
                  data-testid={`campaign-left-tab-${id}`}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors"
                  style={{
                    background: leftTab === id ? "rgba(212,168,67,0.16)" : "rgba(45,31,62,0.55)",
                    border: leftTab === id ? "1px solid rgba(212,168,67,0.5)" : "1px solid rgba(212,168,67,0.18)",
                    color: "#F4E5C1",
                  }}>
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>
      <div className="overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 300px)", minHeight: 200 }}>
        {leftTab === "layers" && <LayersPanel state={state} dispatch={dispatch} />}
        {leftTab === "assets" && <AssetLibraryPanel state={state} dispatch={dispatch} />}
        {leftTab === "templates" && <TemplatesPanel dispatch={dispatch} onApplyTemplate={applyTemplate} />}
      </div>
    </>
  );

  const inspectorBody = (
    <div className="overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 260px)", minHeight: 200 }}>
      <InspectorPanel state={state} dispatch={dispatch} />
    </div>
  );

  return (
    <div
      data-testid="campaign-editor"
      // Breakout: the studio shell constrains content to max-w-[1100px]; a
      // canvas editor needs the full viewport on desktop. Pure-CSS breakout
      // (no shell/layout changes) — collapses to normal flow on mobile.
      className="lg:mx-[calc(50%-50vw)] lg:px-6"
    >
      <TopBar
        configMeta={meta}
        state={state}
        dispatch={dispatch}
        device={device} setDevice={setDevice}
        zoom={zoom} setZoom={setZoom}
        previewTheme={previewTheme} setPreviewTheme={setPreviewTheme}
        showSafeArea={showSafeArea} setShowSafeArea={setShowSafeArea}
        onReplayMotion={() => setMotionPreviewKey((k) => k + 1)}
        onBack={onBack}
        onSave={doSave}
        onPublish={doPublish}
        onUnpublish={doUnpublish}
        saving={saving}
        publishing={publishing}
      />

      {notice && (
        <div className="flex items-center gap-2 rounded-xl px-4 py-2.5 mb-3 text-[12px]"
             style={notice.kind === "error"
               ? { background: "rgba(178,58,72,0.12)", border: "1px solid rgba(178,58,72,0.4)", color: "#F3C9CE" }
               : notice.kind === "info"
                 ? { background: "rgba(58,110,165,0.12)", border: "1px solid rgba(58,110,165,0.4)", color: "#A9C6E8" }
                 : { background: "rgba(46,125,91,0.12)", border: "1px solid rgba(46,125,91,0.4)", color: "#8FD6B2" }}
             data-testid="campaign-editor-notice">
          {notice.kind === "error" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Check className="h-3.5 w-3.5 shrink-0" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} className="ml-auto text-faded hover:text-parchment" aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <SchedulingStrip activeWindow={activeWindow} onChange={setActiveWindow} />

      {/* ── desktop: 3-pane · mobile: canvas + drawers ── */}
      <div className="flex gap-3 items-start">
        <aside className="hidden lg:block w-[300px] xl:w-[330px] shrink-0 rounded-2xl p-3"
               style={{ background: "rgba(20,14,32,0.72)", border: "1px solid rgba(212,168,67,0.25)" }}
               data-testid="campaign-left-panel">
          {leftPanelBody}
        </aside>

        <main className="flex-1 min-w-0 rounded-2xl p-4 overflow-auto"
              style={{ background: "rgba(13,10,22,0.55)", border: "1px solid rgba(212,168,67,0.16)" }}>
          <CanvasStage
            state={state}
            dispatch={dispatch}
            appTheme={previewTheme}
            stageWidth={stageWidth}
            showSafeArea={showSafeArea}
            motionPreviewKey={motionPreviewKey}
          />
          <p className="text-center text-[10px] text-faded mt-3">
            Click any object to edit it · drag to move · corners resize · top handle rotates · arrows nudge
          </p>
        </main>

        <aside className="hidden lg:block w-[290px] xl:w-[320px] shrink-0 rounded-2xl p-3"
               style={{ background: "rgba(20,14,32,0.72)", border: "1px solid rgba(212,168,67,0.25)" }}
               data-testid="campaign-inspector-panel">
          {inspectorBody}
        </aside>
      </div>

      {/* ── mobile toolbar + sheets ── */}
      <div className="lg:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex gap-2 rounded-full px-3 py-2"
           style={{ background: "rgba(20,14,32,0.92)", border: "1px solid rgba(212,168,67,0.35)", backdropFilter: "blur(12px)", boxShadow: "0 12px 34px rgba(0,0,0,0.5)" }}>
        <button type="button" onClick={() => setMobilePanel(mobilePanel === "left" ? null : "left")}
                data-testid="campaign-mobile-left-toggle"
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-parchment"
                style={{ background: mobilePanel === "left" ? "rgba(212,168,67,0.2)" : "rgba(45,31,62,0.8)" }}>
          <Shapes className="h-3.5 w-3.5" /> Library
        </button>
        <button type="button" onClick={() => setMobilePanel(mobilePanel === "inspector" ? null : "inspector")}
                data-testid="campaign-mobile-inspector-toggle"
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-parchment"
                style={{ background: mobilePanel === "inspector" ? "rgba(212,168,67,0.2)" : "rgba(45,31,62,0.8)" }}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Inspect
        </button>
      </div>

      {mobilePanel && (
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 rounded-t-3xl p-4 pb-20 max-h-[70vh] overflow-y-auto"
             style={{ background: "rgba(15,10,22,0.98)", border: "1px solid rgba(212,168,67,0.3)", boxShadow: "0 -18px 50px rgba(0,0,0,0.6)" }}
             data-testid="campaign-mobile-sheet">
          {mobilePanel === "left" ? leftPanelBody : inspectorBody}
        </div>
      )}
    </div>
  );
}

/* ────────────────────── root ────────────────────── */
export default function CampaignDesignStudio() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // config being edited
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await listExperienceConfigs(EXPERIENCE_TYPE);
      setConfigs(r?.configs || []);
    } catch (e) {
      setError(e?.message || "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = useCallback(async (key) => {
    setError("");
    try {
      const canvas = makeDefaultCanvas();
      const r = await createExperienceConfig({
        experienceType: EXPERIENCE_TYPE,
        key: key || `campaign-${new Date().toISOString().slice(0, 10)}`,
        content: { visible: true, canvas },
        appearance: { syncMode: "followTheme" },
        motion: { preset: "layeredElegant" },
      });
      if (r?.config) {
        setConfigs((prev) => [r.config, ...prev]);
        setEditing(r.config);
      }
    } catch (e) {
      setError(e?.message || "Create failed");
    }
  }, []);

  const handleDuplicate = useCallback(async (c) => {
    setBusyId(c.id);
    try {
      const r = await duplicateExperienceConfig(c.id);
      if (r?.config) setConfigs((prev) => [r.config, ...prev]);
    } catch (e) {
      setError(e?.message || "Duplicate failed");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(async (c) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete campaign “${c.key}”?${c.status === "published" ? " It is currently LIVE." : ""}`)) return;
    setBusyId(c.id);
    try {
      await deleteExperienceConfig(c.id, { force: c.status === "published" });
      setConfigs((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e) {
      setError(e?.message || "Delete failed");
    } finally {
      setBusyId(null);
    }
  }, []);

  const syncConfig = useCallback((updated) => {
    setConfigs((prev) => prev.map((c) => {
      if (c.id === updated.id) return updated;
      // publishing one config does not auto-unpublish others server-side;
      // keep list as-is otherwise.
      return c;
    }));
  }, []);

  if (editing) {
    return (
      <CampaignEditor
        key={editing.id}
        config={editing}
        onBack={() => { setEditing(null); refresh(); }}
        onSaved={syncConfig}
        onStatusChange={syncConfig}
      />
    );
  }

  return (
    <CampaignBrowser
      configs={configs}
      loading={loading}
      error={error}
      onRefresh={refresh}
      onCreate={handleCreate}
      onEdit={setEditing}
      onDuplicate={handleDuplicate}
      onDelete={handleDelete}
      busyId={busyId}
    />
  );
}
