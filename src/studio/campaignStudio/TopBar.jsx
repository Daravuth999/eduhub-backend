/**
 * TopBar.jsx — Campaign Design Studio 2.0 editor top bar: back, campaign
 * key, undo/redo, device preview widths, zoom, day/night, safe area, motion
 * replay, artwork mode, Save / Publish.
 */
import {
  ArrowLeft, Undo2, Redo2, Smartphone, Tablet, Monitor, Sun, Moon,
  Frame, Play, Save, Rocket, Undo as UnpublishIcon, Loader2,
} from "lucide-react";
import { ARTWORK_MODES } from "../../eduhub/lib/campaignCanvas/canvasSchema";

const DEVICES = [
  { id: "phone", width: 380, Icon: Smartphone, label: "Phone" },
  { id: "tablet", width: 640, Icon: Tablet, label: "Tablet" },
  { id: "desktop", width: 980, Icon: Monitor, label: "Desktop" },
];

const ZOOMS = [0.75, 1, 1.25, 1.5];

function IconBtn({ onClick, disabled, title, active, children, testid }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      data-testid={testid}
      className="grid place-items-center h-8 w-8 rounded-full transition-colors"
      style={{
        background: active ? "rgba(212,168,67,0.18)" : "rgba(45,31,62,0.6)",
        border: active ? "1px solid rgba(212,168,67,0.55)" : "1px solid rgba(212,168,67,0.2)",
        color: disabled ? "rgba(244,229,193,0.3)" : "#F4E5C1",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export default function TopBar({
  configMeta, state, dispatch,
  device, setDevice, zoom, setZoom,
  previewTheme, setPreviewTheme,
  showSafeArea, setShowSafeArea,
  onReplayMotion,
  onBack, onSave, onPublish, onUnpublish,
  saving, publishing,
}) {
  const { canvas, history, future, dirty } = state;
  const published = configMeta?.status === "published";

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 mb-3"
      style={{ background: "rgba(20,14,32,0.72)", border: "1px solid rgba(212,168,67,0.25)", backdropFilter: "blur(10px)" }}
      data-testid="campaign-studio-topbar"
    >
      <IconBtn onClick={onBack} title="Back to campaigns" testid="campaign-studio-back">
        <ArrowLeft className="h-4 w-4" />
      </IconBtn>

      <div className="flex flex-col min-w-0">
        <span className="text-[12px] font-bold text-parchment truncate max-w-[180px]" data-testid="campaign-studio-key">
          {configMeta?.key || "new campaign"}
        </span>
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: published ? "#8FD6B2" : "rgba(244,229,193,0.6)" }}>
          {published ? "● Live" : "Draft"}{dirty ? " · unsaved" : ""}
        </span>
      </div>

      <div className="h-6 w-px bg-white/10 mx-1" />

      <IconBtn onClick={() => dispatch({ type: "UNDO" })} disabled={!history.length} title="Undo" testid="campaign-studio-undo">
        <Undo2 className="h-4 w-4" />
      </IconBtn>
      <IconBtn onClick={() => dispatch({ type: "REDO" })} disabled={!future.length} title="Redo" testid="campaign-studio-redo">
        <Redo2 className="h-4 w-4" />
      </IconBtn>

      <div className="h-6 w-px bg-white/10 mx-1" />

      {DEVICES.map(({ id, Icon, label }) => (
        <IconBtn key={id} onClick={() => setDevice(id)} active={device === id} title={label} testid={`campaign-studio-device-${id}`}>
          <Icon className="h-4 w-4" />
        </IconBtn>
      ))}

      <select
        value={zoom}
        onChange={(e) => setZoom(Number(e.target.value))}
        aria-label="Zoom"
        data-testid="campaign-studio-zoom-select"
        className="h-8 rounded-full px-2 text-[11px] font-bold"
        style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.2)", color: "#F4E5C1" }}
      >
        {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
      </select>

      <IconBtn
        onClick={() => setPreviewTheme(previewTheme === "dark" ? "light" : "dark")}
        title={previewTheme === "dark" ? "Preview: Night — switch to Day" : "Preview: Day — switch to Night"}
        testid="campaign-studio-theme-toggle"
      >
        {previewTheme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      </IconBtn>

      <IconBtn onClick={() => setShowSafeArea(!showSafeArea)} active={showSafeArea} title="Toggle text safe area" testid="campaign-studio-safearea-toggle">
        <Frame className="h-4 w-4" />
      </IconBtn>

      <IconBtn onClick={onReplayMotion} title="Replay entrance motion" testid="campaign-studio-motion-replay">
        <Play className="h-4 w-4" />
      </IconBtn>

      <select
        value={canvas.artworkMode}
        onChange={(e) => dispatch({ type: "UPDATE_CANVAS", patch: { artworkMode: e.target.value } })}
        aria-label="Artwork mode"
        data-testid="campaign-studio-artwork-mode"
        className="h-8 rounded-full px-2 text-[11px] font-bold"
        style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.2)", color: "#F4E5C1" }}
      >
        {ARTWORK_MODES.map((m) => <option key={m.id} value={m.id}>{m.label} mode</option>)}
      </select>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        data-testid="campaign-studio-save-button"
        className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors"
        style={{
          background: dirty ? "rgba(212,168,67,0.18)" : "rgba(45,31,62,0.6)",
          border: "1px solid rgba(212,168,67,0.45)",
          color: "#F4E5C1",
        }}
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        Save
      </button>

      {published ? (
        <button
          type="button"
          onClick={onUnpublish}
          disabled={publishing}
          data-testid="campaign-studio-unpublish-button"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
          style={{ background: "rgba(178,58,72,0.16)", border: "1px solid rgba(178,58,72,0.5)", color: "#F3C9CE" }}
        >
          {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UnpublishIcon className="h-3.5 w-3.5" />}
          Unpublish
        </button>
      ) : (
        <button
          type="button"
          onClick={onPublish}
          disabled={publishing}
          data-testid="campaign-studio-publish-button"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink"
          style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)", boxShadow: "0 6px 14px rgba(212,168,67,0.35)", color: "#1a1420" }}
        >
          {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
          Publish
        </button>
      )}
    </div>
  );
}

export { DEVICES };
